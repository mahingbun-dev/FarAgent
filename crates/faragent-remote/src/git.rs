//! The bash fallback channel: the tail of the fallback script, with the `git.*`
//! ops and the serving loop.
//!
//! The head ([`crate::fs::POSIX_FALLBACK_HEAD`]) sets the framing rules up;
//! this half uses them, and ends by reading request frames from stdin until it
//! sees EOF. See that module for the script's contract and
//! [`crate::posix_fallback_script`] for how the two halves are joined.
//!
//! `git.status` and `git.log` parse machine formats (`--porcelain=v2 -z`, and a
//! `%x1f`-delimited `--format`), never the human format: those are stable across
//! git versions and locales, and `-z` turns off `core.quotepath`, so a path
//! arrives as the bytes on disk rather than as an escaped form to un-escape.

/// The tail of the fallback script: `git.discover`, `git.status`, `git.log` and
/// the read loop. Concatenated with the head by
/// [`crate::posix_fallback_script`].
pub const POSIX_FALLBACK_TAIL: &str = r#"# ---------------------------------------------------------------------------
# git.*
# ---------------------------------------------------------------------------
#
# Every op takes `root_b64` — the directory the caller is looking at, which may
# be any directory *inside* a worktree — and walks up to find the repository,
# so a subdirectory of a repo answers the same as the repo root.
#
# Everything is parsed from porcelain v2 / `--format` streams with NUL or 0x1f
# separators, never from the human format: those are stable across git versions
# and locales, and `-z` also disables `core.quotepath`, so a path comes back as
# the exact bytes on disk rather than an escaped form a shell would have to
# undo. A shell variable cannot hold a NUL, which is exactly why a NUL is what
# separates the records: `read -d ''` hands them over one at a time, complete.

FIELD_SEP=$'\x1f'
RECORD_SEP=$'\x1e'
LF=$'\n'
LOG_FORMAT='%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%P%x1f%D%x1f%s%x1e'

# `git -C <repo> …` with the locale pinned and neither an index lock nor a
# credential prompt: the same environment the helper gives its git, so a
# read-only query cannot block on a terminal or mutate the user's index.
git_cmd() {
  GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 LC_ALL=C git -C "$@"
}

# Stderr of a git command that is expected to fail, with stdout discarded. A
# shell cannot hold a NUL and git's diagnostics do not contain one, so this is
# safe to capture; either way it is base64'd before it reaches the wire.
git_stderr_of() {
  GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 LC_ALL=C git -C "$@" 2>&1 >/dev/null
}

# The first 2048 bytes of a failing git's diagnostics, or a stand-in when it
# said nothing at all (a killed or signal-terminated git can).
git_failure_text() {
  local text
  text=$(printf '%s' "$1" | head -c 2048)
  if [ -z "$text" ]; then
    printf '%s' "git exited non-zero with no diagnostic output"
  else
    printf '%s' "$text"
  fi
}

no_git_repo() {
  emit_error "$1" not_a_repo "no \`.git\` in $2 or any parent directory"
}

# The worktree root at or above $1, or empty + status 1. `.git` may be a
# directory or a file (a linked worktree, a submodule), so both are accepted.
discover_root() {
  local d="$1"
  while :; do
    if [ -d "$d/.git" ] || [ -f "$d/.git" ]; then printf '%s' "$d"; return 0; fi
    case "$d" in
      /) return 1 ;;
      */*)
        d=${d%/*}
        [ -n "$d" ] || d=/
        ;;
      *) return 1 ;;
    esac
  done
}

# The real git directory of a worktree: `.git` itself, or — where `.git` is a
# file — the path that file's `gitdir:` line points at, resolved against the
# worktree when it is not absolute.
git_dir_of() {
  local d="$1" target
  if [ -d "$d/.git" ]; then printf '%s' "$d/.git"; return 0; fi
  target=$(sed -n 's/^gitdir:[[:space:]]*//p' "$d/.git" 2>/dev/null | head -n 1)
  # Trim trailing whitespace, the way `str::trim` does before `Path::new`.
  target=${target%"${target##*[![:space:]]}"}
  if [ -z "$target" ]; then printf '%s' "$d/.git"; return 0; fi
  case "$target" in
    /*) printf '%s' "$target" ;;
    *) printf '%s' "$d/$target" ;;
  esac
}

op_git_discover() {
  local id="$1" asked="$2" asked_b64="$3" repo name trimmed
  repo=$(discover_root "$asked")
  if [ -z "$repo" ]; then
    no_git_repo "$id" "$asked"
    return 0
  fi
  # The name is the repository directory's own name, whatever the caller asked
  # for — a trailing slash is not part of it.
  trimmed=$repo
  while [ "${#trimmed}" -gt 1 ]; do
    case "$trimmed" in
      */) trimmed=${trimmed%/} ;;
      *) break ;;
    esac
  done
  name=${trimmed##*/}
  if [ "$name" = . ]; then name=''; fi
  emit_data "$id" "{\"path_b64\":\"$asked_b64\",\"root_b64\":\"$(b64 "$repo")\",\"git_dir_b64\":\"$(b64 "$(git_dir_of "$repo")")\",\"name_b64\":\"$(b64 "$name")\"}"
}

# Porcelain v2's two status letters → the helper's per-file fields. A `.` is
# "unmodified in this tree", `?` is "untracked here"; anything else is a change,
# and `staged` is exactly "the index letter is a real change".
set_xy() {
  local unmerged="$2"
  XY_X=${1%?}
  XY_Y=${1#?}
  case "$XY_X" in
    .|\?) XY_STAGED=false ;;
    *) XY_STAGED=true ;;
  esac
  if [ "$unmerged" = true ]; then
    XY_STATUS=conflicted
  elif [ "$XY_STAGED" = true ]; then
    XY_STATUS=$(letter_status "$XY_X")
  else
    XY_STATUS=$(letter_status "$XY_Y")
  fi
}

letter_status() {
  case "$1" in
    A) printf added ;;
    D) printf deleted ;;
    R) printf renamed ;;
    C) printf copied ;;
    T) printf typechange ;;
    *) printf modified ;;
  esac
}

# Sets SECOND_FIELD to the second space-separated field of $1.
second_field() {
  local s="$1"
  s=${s#* }
  SECOND_FIELD=${s%% *}
}

# Sets AFTER_FIELDS to $1 with its first $2 space-separated fields removed, and
# AFTER_OK to whether there were that many. This peeling is what keeps a path's
# own spaces (and every other byte) intact: the field count is fixed by the
# porcelain v2 grammar per record type, so the remainder is the path, verbatim,
# with nothing decoded and nothing re-quoted. A record too short to hold its own
# fields is skipped rather than turned into an entry with a nonsense path —
# which is what the helper's `split_fields`-then-check does.
after_fields() {
  local s="$1" n="$2" i=0
  AFTER_OK=true
  while [ "$i" -lt "$n" ]; do
    case "$s" in
      *' '*) s=${s#* } ;;
      *)
        AFTER_FIELDS=''
        AFTER_OK=false
        return 0
        ;;
    esac
    i=$((i + 1))
  done
  AFTER_FIELDS=$s
}

# Append one entry to the files array under construction. Globals, because a
# subshell would lose the accumulator.
append_file() {
  # $1 path, $2 rename origin ('' for none), $3 index letter, $4 worktree
  # letter, $5 staged bool, $6 status enum
  local orig=null
  if [ -n "$2" ]; then orig="\"$(b64 "$2")\""; fi
  FILES_JSON="$FILES_JSON$FILES_SEP{\"path_b64\":\"$(b64 "$1")\",\"orig_path_b64\":$orig,\"index\":\"$3\",\"worktree\":\"$4\",\"staged\":$5,\"status\":\"$6\"}"
  FILES_SEP=,
  FILES_COUNT=$((FILES_COUNT + 1))
}

# One `# key value` header line of `status --branch`.
apply_status_head() {
  local key value=''
  case "$1" in
    *' '*)
      key=${1%% *}
      value=${1#* }
      ;;
    *) key=$1 ;;
  esac
  case "$key" in
    branch.oid)
      if [ "$value" = '(initial)' ]; then STATUS_INITIAL=true; else STATUS_OID=$value; fi
      ;;
    branch.head)
      if [ "$value" = '(detached)' ]; then STATUS_DETACHED=true; else STATUS_BRANCH=$value; fi
      ;;
    branch.upstream) STATUS_UPSTREAM=$value ;;
    branch.ab)
      # "+3 -1", in that order, each part optional.
      local part
      for part in $value; do
        case "$part" in
          +*) STATUS_AHEAD=${part#+} ;;
          -*) STATUS_BEHIND=${part#-} ;;
        esac
      done
      ;;
  esac
}

op_git_status() {
  local id="$1" asked="$2" asked_b64="$3" repo err rc
  repo=$(discover_root "$asked")
  if [ -z "$repo" ]; then
    no_git_repo "$id" "$asked"
    return 0
  fi
  # One run to learn the exit status and collect the diagnostics ...
  err=$(git_stderr_of "$repo" status --porcelain=v2 --branch --untracked-files=all -z)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    emit_error "$id" git_failed "$(git_failure_text "$err")"
    return 0
  fi
  # ... and a second to stream the records. Two runs, because a NUL-separated
  # stream can only be consumed by `read -d ''`, whose status cannot be checked
  # across a pipeline — and a shell cannot hold a NUL to buffer the stream the
  # way the helper buffers it. The snapshot the caller sees is git's, either
  # way: this is a read-only query, and a change landing between the two runs
  # changes only which of two real states is reported.
  FILES_JSON=''
  FILES_SEP=''
  FILES_COUNT=0
  STATUS_BRANCH=''
  STATUS_OID=''
  STATUS_UPSTREAM=''
  STATUS_AHEAD=''
  STATUS_BEHIND=''
  STATUS_DETACHED=false
  STATUS_INITIAL=false
  local truncated=false rec orig
  while IFS= read -r -d '' rec; do
    if [ -z "$rec" ]; then continue; fi
    case "$rec" in
      '# '*)
        apply_status_head "${rec#\# }"
        continue
        ;;
    esac
    if [ "$FILES_COUNT" -ge "$MAX_LIST_ENTRIES" ]; then truncated=true; break; fi
    case "$rec" in
      '1 '*)
        after_fields "$rec" 8
        if [ "$AFTER_OK" = false ]; then continue; fi
        second_field "$rec"
        set_xy "$SECOND_FIELD" false
        append_file "$AFTER_FIELDS" '' "$XY_X" "$XY_Y" "$XY_STAGED" "$XY_STATUS"
        ;;
      '2 '*)
        after_fields "$rec" 9
        if [ "$AFTER_OK" = false ]; then continue; fi
        second_field "$rec"
        set_xy "$SECOND_FIELD" false
        # The pre-rename path is the very next NUL-terminated record. Reading it
        # here — not in the next iteration — is what keeps the entry when this
        # was the last record before the cap.
        orig=''
        IFS= read -r -d '' orig || true
        append_file "$AFTER_FIELDS" "$orig" "$XY_X" "$XY_Y" "$XY_STAGED" "$XY_STATUS"
        ;;
      'u '*)
        after_fields "$rec" 10
        if [ "$AFTER_OK" = false ]; then continue; fi
        second_field "$rec"
        set_xy "$SECOND_FIELD" true
        append_file "$AFTER_FIELDS" '' "$XY_X" "$XY_Y" "$XY_STAGED" "$XY_STATUS"
        ;;
      '? '*)
        append_file "${rec#* }" '' '?' '?' false untracked
        ;;
    esac
  done < <(git_cmd "$repo" status --porcelain=v2 --branch --untracked-files=all -z 2>/dev/null)

  # Only shapes that cannot break a JSON string may be spliced plain.
  is_hex "$STATUS_OID" || STATUS_OID=''
  is_digits "$STATUS_AHEAD" || STATUS_AHEAD=''
  is_digits "$STATUS_BEHIND" || STATUS_BEHIND=''
  local branch_json=null oid_json=null upstream_json=null ahead_json=null behind_json=null clean=false
  if [ -n "$STATUS_BRANCH" ]; then branch_json="\"$(b64 "$STATUS_BRANCH")\""; fi
  if [ -n "$STATUS_OID" ]; then oid_json="\"$STATUS_OID\""; fi
  if [ -n "$STATUS_UPSTREAM" ]; then upstream_json="\"$(b64 "$STATUS_UPSTREAM")\""; fi
  if [ -n "$STATUS_AHEAD" ]; then ahead_json=$STATUS_AHEAD; fi
  if [ -n "$STATUS_BEHIND" ]; then behind_json=$STATUS_BEHIND; fi
  # `clean` is about the repository, not about the list that fit: a truncated
  # listing is not clean either way.
  if [ "$FILES_COUNT" -eq 0 ] && [ "$truncated" = false ]; then clean=true; fi
  emit_data "$id" "{\"path_b64\":\"$asked_b64\",\"root_b64\":\"$(b64 "$repo")\",\"branch_b64\":$branch_json,\"oid\":$oid_json,\"detached\":$STATUS_DETACHED,\"initial\":$STATUS_INITIAL,\"upstream_b64\":$upstream_json,\"ahead\":$ahead_json,\"behind\":$behind_json,\"files\":[$FILES_JSON],\"clean\":$clean,\"truncated\":$truncated}"
}

# Append one commit to the array under construction.
append_commit() {
  # $1 hash, $2 short, $3 author, $4 email, $5 author date, $6 commit date,
  # $7 parents JSON, $8 refs ('' for none), $9 subject
  local refs_json=null
  if [ -n "$8" ]; then refs_json="\"$(b64 "$8")\""; fi
  COMMITS_JSON="$COMMITS_JSON$COMMITS_SEP{\"hash\":\"$1\",\"short\":\"$2\",\"author_b64\":\"$(b64 "$3")\",\"email_b64\":\"$(b64 "$4")\",\"author_date\":\"$5\",\"commit_date\":\"$6\",\"parents\":$7,\"refs_b64\":$refs_json,\"subject_b64\":\"$(b64 "$9")\"}"
  COMMITS_SEP=,
  COMMITS_COUNT=$((COMMITS_COUNT + 1))
}

# One `%x1e`-terminated record → ten `%x1f`-separated fields. A record with
# fewer fields than that is not a commit and is skipped without counting, so a
# future git adding output cannot desynchronise the page.
parse_commit() {
  local rec="$1"
  local f_hash f_short f_an f_ae f_ai f_ci f_parents f_refs f_subject
  IFS=$FIELD_SEP read -r f_hash f_short f_an f_ae f_ai f_ci f_parents f_refs f_subject <<<"$rec"
  # Only shapes that cannot break a JSON string may be spliced plain; a date
  # that is not ISO 8601, or an oid that is not hex, is dropped to ''.
  is_hex "$f_hash" || f_hash=''
  is_hex "$f_short" || f_short=''
  is_date "$f_ai" || f_ai=''
  is_date "$f_ci" || f_ci=''
  local inner='' sep='' p
  for p in $f_parents; do
    if is_hex "$p"; then
      inner="$inner$sep\"$p\""
      sep=,
    fi
  done
  append_commit "$f_hash" "$f_short" "$f_an" "$f_ae" "$f_ai" "$f_ci" "[$inner]" "$f_refs" "$f_subject"
}

op_git_log() {
  local id="$1" line="$2" asked="$3" repo limit skip path_arg raw rawp rc err
  repo=$(discover_root "$asked")
  if [ -z "$repo" ]; then
    no_git_repo "$id" "$asked"
    return 0
  fi
  opt_u64 limit "$line"
  if [ "$OPT_BAD" = 1 ]; then
    emit_error "$id" bad_request "\`limit\` must be a non-negative integer"
    return 0
  fi
  if [ -n "$OPT_U64" ]; then limit=$OPT_U64; else limit=$DEFAULT_LOG_LIMIT; fi
  clamp_u64 "$limit" 1 "$MAX_LIST_ENTRIES"
  limit=$CLAMPED
  opt_u64 skip "$line"
  if [ "$OPT_BAD" = 1 ]; then
    emit_error "$id" bad_request "\`skip\` must be a non-negative integer"
    return 0
  fi
  if [ -n "$OPT_U64" ]; then skip=$OPT_U64; else skip=0; fi
  path_arg=''
  rawp=$(request_b64 path_b64 "$line")
  if [ -n "$rawp" ]; then
    if ! b64_ok "$rawp"; then
      emit_error "$id" bad_request "\`path_b64\` is not valid base64"
      return 0
    fi
    decode_b64 "$rawp"
    path_arg=$DECODED
    if [ -z "$path_arg" ]; then
      emit_error "$id" bad_request "\`path_b64\` is required"
      return 0
    fi
  fi
  # One commit more than asked for: if that one arrives there is another page,
  # which answers `truncated` without a second traversal.
  local max_count=$((limit + 1))
  if [ -n "$path_arg" ]; then
    raw=$(git_cmd "$repo" log "--max-count=$max_count" "--skip=$skip" "--format=$LOG_FORMAT" -- "$path_arg" 2>/dev/null)
  else
    raw=$(git_cmd "$repo" log "--max-count=$max_count" "--skip=$skip" "--format=$LOG_FORMAT" 2>/dev/null)
  fi
  rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ -n "$path_arg" ]; then
      err=$(git_stderr_of "$repo" log "--max-count=$max_count" "--skip=$skip" "--format=$LOG_FORMAT" -- "$path_arg")
    else
      err=$(git_stderr_of "$repo" log "--max-count=$max_count" "--skip=$skip" "--format=$LOG_FORMAT")
    fi
    emit_error "$id" git_failed "$(git_failure_text "$err")"
    return 0
  fi
  COMMITS_JSON=''
  COMMITS_SEP=''
  COMMITS_COUNT=0
  local truncated=false rest=$raw rec seps
  while [ -n "$rest" ]; do
    case "$rest" in
      *"$RECORD_SEP"*)
        rec=${rest%%"$RECORD_SEP"*}
        rest=${rest#*"$RECORD_SEP"}
        ;;
      *)
        rec=$rest
        rest=''
        ;;
    esac
    # A record is preceded by the newline that ended the previous one.
    rec=${rec#$LF}
    rec=${rec%$LF}
    if [ -z "$rec" ]; then continue; fi
    # A subject containing the record separator splits one commit into two
    # records, the second of which holds no fields at all. The helper skips a
    # record with fewer than nine fields, and — this is the part that matters —
    # does not count it toward the page; counting the 0x1f bytes is how this
    # reaches the same verdict without splitting the record a second time.
    seps=${rec//[!$FIELD_SEP]/}
    if [ "${#seps}" -lt 8 ]; then continue; fi
    if [ "$COMMITS_COUNT" -ge "$limit" ]; then truncated=true; break; fi
    parse_commit "$rec"
  done
  emit_data "$id" "{\"root_b64\":\"$(b64 "$repo")\",\"limit\":$limit,\"skip\":$skip,\"commits\":[$COMMITS_JSON],\"truncated\":$truncated}"
}

op_git_dispatch() {
  local id="$1" line="$2" op="$3"
  if [ "$HAVE_GIT" != true ]; then
    emit_error "$id" internal "\`git\` was not found on PATH on the remote host"
    return 0
  fi
  take_field "$id" "$line" root_b64 || return 0
  local asked="$FIELD_BYTES" asked_b64="$FIELD_B64"
  case "$op" in
    git.discover) op_git_discover "$id" "$asked" "$asked_b64" ;;
    git.status) op_git_status "$id" "$asked" "$asked_b64" ;;
    git.log) op_git_log "$id" "$line" "$asked" ;;
    *) emit_error "$id" bad_request "unknown op \`$op\`" ;;
  esac
}

# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------
#
# bash only: `read -d ''`, `${v//pat/rep}` and process substitution are used
# above, so this must run under bash — which is how the transport delivers it
# (`bash -lc`). One line in, exactly one line out, for as long as stdin is
# open — including for a line that is empty or is not JSON at all, which the
# helper answers with a `bad_request` too. One reply per line, always, is what
# keeps the channel from falling out of step with a client that is waiting.
#
# `${#line}` counts bytes here because LC_ALL=C is pinned above; the cap is
# checked before the line is served, so a frame that cannot be a frame is
# refused without being scanned.

while IFS= read -r line || [ -n "$line" ]; do
  if [ "${#line}" -gt "$MAX_FRAME_BYTES" ]; then
    emit_error null bad_request "request frame exceeds the $MAX_FRAME_BYTES byte cap"
    continue
  fi
  serve_line "$line"
done

exit 0
"#;
