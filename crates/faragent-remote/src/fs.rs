//! The bash fallback channel: the head of the fallback script, with the
//! framing rules and the `fs.*` ops it implements.
//!
//! A remote that cannot run the `faragent-helper` binary — no build for its
//! architecture, a `noexec` mount, an unwritable home, no checksum tool — can
//! still be served by a script. [`POSIX_FALLBACK_HEAD`] and
//! [`crate::git::POSIX_FALLBACK_TAIL`] are the two halves of one bash program;
//! [`crate::posix_fallback_script`] concatenates them, and the transport streams
//! the result to the remote once (`bash -lc '<script>'`, all three stdio piped,
//! exactly like the helper). From then on the script is a long-lived NDJSON
//! peer: request frames on stdin, reply frames on stdout.
//!
//! The script's own header comment — the first thing inside the raw string below
//! — is the authoritative description of the wire format and of the byte-safety
//! argument for hand-built frames. Read it there; it is deliberately kept in the
//! script rather than restated here, because the script is what a reader of the
//! wire sees.
//!
//! The op set is read-only on purpose: `fs.list`, `fs.read`, `fs.stat` here,
//! `git.discover`, `git.status`, `git.log` in
//! [`crate::git::POSIX_FALLBACK_TAIL`]. Nothing in the fallback writes.

/// The head of the fallback script: shell setup, the framing helpers, `fs.*`
/// and `ping`. Concatenated with the tail by [`crate::posix_fallback_script`].
///
/// It is a `&str`, not a `format!` template: every `{` in it is shell syntax.
/// The one substitution point is the `ping` version, spelled `@@VERSION@@` and
/// filled in by [`crate::posix_fallback_script`].
pub const POSIX_FALLBACK_HEAD: &str = r#"# ===========================================================================
# FarAgent fallback channel — a long-lived NDJSON peer, in bash.
#
# Used when the `faragent-helper` binary cannot be deployed (no build for the
# architecture, a noexec mount, an unwritable home, a missing checksum tool).
# The transport streams this script to the remote once
# (`OpenSshTransport::spawn_login_stdio_stream`, i.e. `bash -lc '<script>'`,
# all three stdio piped) and then speaks to it exactly as it speaks to the
# helper: requests on stdin, frames on stdout.
#
# The wire format is faragent-helper's `proto.rs`, verbatim:
#   * one JSON object per line, `\n`-terminated; stdout carries frames and
#     nothing else — a stray debug line is a protocol violation
#   * a request carries `op` (and normally `id`); a reply carries `id` + `ok`;
#     a push carries `event` and no `id`
#   * every value that can hold arbitrary bytes travels base64 in a field named
#     `*_b64`; pure scalars (bools, counts, enums, git object ids) stay plain
#   * an error is {"id":…,"ok":false,"error":{"code":<closed set>,
#     "message_b64":<base64>}}
#   * one frame — the JSON line without its newline — may not exceed
#     MAX_FRAME_BYTES; an oversized reply is replaced by a `too_large` error
#   * there is no magic marker line: a client skips whatever does not parse as
#     a frame, which is also what tolerates a login shell's banner
#
# This file is the head of the script: the framing rules and the `fs.*` ops.
# `git.rs` holds the tail (`git.*` and the serving loop); `lib.rs` concatenates
# the two into the text the transport streams.
#
# Byte safety, which is the whole reason the protocol has the `_b64` rule: a
# shell has no JSON encoder, so every frame here is written by hand. The only
# text lifted off the wire and spliced into a frame as a *plain* JSON scalar is
# the request id, and `request_id` re-emits only shapes it can spell
# byte-exactly. Paths, names, error messages, branch names and commit subjects
# all go out base64, so no escaping is ever needed on either side. If you ever
# need to put untrusted text somewhere else, that is a design error: base64 it,
# or extend `request_id`'s proof — do not add escaping.
# ===========================================================================

LC_ALL=C
export LC_ALL
# Default word splitting, whatever the login environment left behind.
unset IFS

MAX_FRAME_BYTES=8388608
DEFAULT_READ_LIMIT=262144
MAX_READ_CHUNK=4194304
MAX_FILE_BYTES=268435456
MAX_LIST_ENTRIES=500
DEFAULT_LOG_LIMIT=50
SNIFF_BYTES=8192

# The file-type bits of st_mode, for "is this a regular file" without a second
# stat and without following a link.
S_IFMT_DEC=61440
S_IFREG_DEC=32768

if command -v base64 >/dev/null 2>&1; then
  HAVE_BASE64=true
else
  HAVE_BASE64=false
fi
if command -v git >/dev/null 2>&1; then
  HAVE_GIT=true
else
  HAVE_GIT=false
fi

# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------

# base64 of one byte string — the only encoding this protocol allows for
# anything that is not a pure scalar. `base64 -w0` is GNU-only, so the BSD
# (macOS) line wrapping is undone with tr instead.
b64() {
  printf '%s' "$1" | base64 2>/dev/null | tr -d '\n'
}

# Decode $1 into DECODED, byte-exact. The trailing 'x' sentinel is what keeps
# command substitution from eating a trailing newline, which a hostile file
# name may legitimately end with.
decode_b64() {
  DECODED=$(printf '%s' "$1" | base64 -d 2>/dev/null; printf x)
  DECODED=${DECODED%x}
}

# Is $1 base64 at all? The helper decodes with the `base64` crate's STANDARD
# engine, whose padding is canonical, so this checks the same thing: the
# alphabet, a length that is a whole number of four-character groups, and `=`
# only ever as the one or two characters of a canonical final group. Anything
# that passes here decodes identically under `base64 -d` and under STANDARD;
# anything that does not is answered bad_request rather than decoded to bytes
# the two implementations could disagree about.
b64_ok() {
  local body="$1" pads=0
  case "$body" in
    *[!A-Za-z0-9+/=]*) return 1 ;;
  esac
  [ $(( ${#body} % 4 )) -eq 0 ] || return 1
  case "$body" in
    *==) body=${body%==}; pads=2 ;;
    *=) body=${body%=}; pads=1 ;;
  esac
  case "$body" in
    *=*) return 1 ;;
  esac
  case "$(( ${#body} % 4 )):$pads" in
    0:0 | 2:2 | 3:1) return 0 ;;
    *) return 1 ;;
  esac
}

# True when $1 is non-empty and holds only digits — a shape that may travel as
# a plain JSON number.
is_digits() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# True when $1 is non-empty and holds only hex digits — a git object id, which
# may travel as a plain JSON string.
is_hex() {
  case "$1" in
    ''|*[!0-9a-fA-F]*) return 1 ;;
    *) return 0 ;;
  esac
}

# True when $1 is shaped like the strict ISO 8601 git's %aI/%cI emit; only then
# may it travel as a plain JSON string.
is_date() {
  case "$1" in
    ''|*[!0-9T:+.Z-]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Clamp the digit string $1 into [$2, $3], into CLAMPED. A string longer than
# any value these caps can hold is clamped to the maximum first, so a caller
# sending a 40-digit `limit` cannot overflow a shell integer or make a `[ -gt ]`
# comparison fail (both of which a plain `-gt` would do).
clamp_u64() {
  if [ "${#1}" -gt 18 ]; then
    CLAMPED=$3
  elif [ "$1" -lt "$2" ]; then
    CLAMPED=$2
  elif [ "$1" -gt "$3" ]; then
    CLAMPED=$3
  else
    CLAMPED=$1
  fi
}

# The raw JSON text to echo back as `id`, or `null`.
#
# THIS IS THE ONLY PLACE UNTRUSTED TEXT BECOMES A PLAIN JSON SCALAR. It is safe
# because it re-emits only shapes that need no escaping: a bare integer, or a
# quoted token drawn from [A-Za-z0-9._:-] (which cannot contain a quote, a
# backslash or a control character). Everything else — a float, a string with
# escapes, an object, a nested array — becomes `null`, so an exotic id costs
# the caller the attribution of that reply, never the validity of the stream.
# Only a line shaped like a JSON object is scanned at all, so a stray line of
# text cannot steal an id that belongs to a later request.
request_id() {
  case "$1" in
    '{'*'}') : ;;
    *) printf null; return 0 ;;
  esac
  local num str
  num=$(printf '%s' "$1" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\(-\{0,1\}[0-9][0-9]*\)\([,}].*\)\{0,1\}$/\1/p')
  if [ -n "$num" ]; then printf '%s' "$num"; return 0; fi
  str=$(printf '%s' "$1" | sed -n 's|.*"id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9._:-]*\)"\([,}].*\)\{0,1\}$|\1|p')
  if [ -n "$str" ]; then printf '"%s"' "$str"; return 0; fi
  printf null
}

# The `op` as a bare token, or empty. The op vocabulary is [a-z.] only, so this
# cannot smuggle anything into a frame even if it were spliced rather than
# tested with `case`. The trailing `.*` matters: without it, sed substitutes
# the matched span and passes the rest of the line through, so the "op" would
# come back glued to the remainder of the frame.
request_op() {
  printf '%s' "$1" | sed -n 's|.*"op"[[:space:]]*:[[:space:]]*"\([a-z][a-z.]*\)".*|\1|p'
}

# A `*_b64` field's payload, or empty when it is absent or malformed. The
# charset restriction is what makes the extraction safe to splice back into a
# JSON string later: base64 holds no quote, no backslash and no whitespace, so
# a value that survives this function cannot break out of the frame. A key can
# never be confused with base64 payload text either, because a JSON key is
# quoted and base64 contains no quote.
request_b64() {
  printf '%s' "$2" | sed -n "s|.*\"$1\"[[:space:]]*:[[:space:]]*\"\([A-Za-z0-9+/=]*\)\".*|\1|p"
}

# The raw text of a numeric field, or empty when absent, null, or not a bare
# number. Stops at the `,` or `}` that ends the value, so `1.5` and `-5` come
# back as themselves and are rejected by the caller rather than truncated to a
# prefix.
request_number() {
  printf '%s' "$2" | sed -n "s|.*\"$1\"[[:space:]]*:[[:space:]]*\([^,}[:space:]]*\).*|\1|p"
}

request_has() {
  printf '%s' "$2" | grep -q "\"$1\"[[:space:]]*:"
}

request_is_null() {
  printf '%s' "$2" | grep -q "\"$1\"[[:space:]]*:[[:space:]]*null"
}

# Optional u64 parameter, with exactly the helper's three outcomes: absent or
# null → OPT_U64 empty, OPT_BAD 0; a JSON number that is a non-negative integer
# → OPT_U64 set; anything else (a float, a negative, a string, a bool) →
# OPT_BAD 1, and the caller answers bad_request with the helper's own message.
# Globals, not stdout, because a command substitution is a subshell and a flag
# set inside one would not survive.
opt_u64() {
  OPT_U64=''
  OPT_BAD=0
  local token
  token=$(request_number "$1" "$2")
  case "$token" in
    ''|null)
      if [ -z "$token" ] && request_has "$1" "$2" && ! request_is_null "$1" "$2"; then
        OPT_BAD=1
      fi
      ;;
    *[!0-9]*) OPT_BAD=1 ;;
    *) OPT_U64=$token ;;
  esac
}

# Extract a required `*_b64` field into FIELD_BYTES (the bytes) and FIELD_B64
# (their canonical re-encoding, which is what the reply echoes — the helper
# re-encodes too, so a request that arrived with non-canonical padding gets the
# same answer from both implementations). Answers bad_request and returns 1
# when the field is missing, empty or not base64.
take_field() {
  local id="$1" line="$2" key="$3" raw
  raw=$(request_b64 "$key" "$line")
  if [ -z "$raw" ]; then
    emit_error "$id" bad_request "\`$key\` is required"
    return 1
  fi
  if ! b64_ok "$raw"; then
    emit_error "$id" bad_request "\`$key\` is not valid base64"
    return 1
  fi
  decode_b64 "$raw"
  if [ -z "$DECODED" ]; then
    emit_error "$id" bad_request "\`$key\` is required"
    return 1
  fi
  FIELD_BYTES=$DECODED
  FIELD_B64=$(b64 "$FIELD_BYTES")
  return 0
}

# A successful reply, with the 8 MiB cap enforced in one place: a reply too big
# to be a frame becomes a `too_large` error instead of a broken connection.
emit_data() {
  local line="{\"id\":$1,\"ok\":true,\"data\":$2}"
  if [ "${#line}" -gt "$MAX_FRAME_BYTES" ]; then
    emit_error "$1" too_large "the reply exceeds the $MAX_FRAME_BYTES byte frame cap; ask for less"
  else
    printf '%s\n' "$line"
  fi
}

# An error reply. `message` may hold any bytes at all: it is base64 on the
# wire, which is the point of `message_b64`.
emit_error() {
  printf '{"id":%s,"ok":false,"error":{"code":"%s","message_b64":"%s"}}\n' \
    "$1" "$2" "$(b64 "$3")"
}

# ---------------------------------------------------------------------------
# stat(2), across the two `stat` dialects
# ---------------------------------------------------------------------------

# GNU stat spells it -c '%s %Y %f' (mode in hex); BSD/macOS -f '%z %m %p'
# (mode in octal). Without -L both report the *link* itself, which is what the
# helper's `symlink_metadata` does; `fs.read` passes 1, because it opens what
# the link points at, exactly as the helper's `fs::metadata` does.
if stat -c '%s' . >/dev/null 2>&1; then
  STAT_FLAVOR=gnu
else
  STAT_FLAVOR=bsd
fi

# Sets ST_SIZE, ST_MTIME and ST_MODE (decimal st_mode, file-type bits included,
# matching the helper's `Metadata::mode()`). Returns 1 when the path cannot be
# stat'ed.
stat_path() {
  local follow="$1" p="$2" out flag=''
  if [ "$follow" = 1 ]; then flag=-L; fi
  if [ "$STAT_FLAVOR" = gnu ]; then
    out=$(stat $flag -c '%s %Y %f' -- "$p" 2>/dev/null)
  else
    out=$(stat $flag -f '%z %m %p' -- "$p" 2>/dev/null)
  fi
  case "$out" in
    *' '*' '*) : ;;
    *) return 1 ;;
  esac
  ST_SIZE=${out%% *}
  out=${out#* }
  ST_MTIME=${out%% *}
  ST_MODE_RAW=${out#* }
  is_digits "$ST_SIZE" || return 1
  is_digits "$ST_MTIME" || return 1
  if [ "$STAT_FLAVOR" = gnu ]; then
    case "$ST_MODE_RAW" in
      ''|*[!0-9a-fA-F]*) return 1 ;;
    esac
    ST_MODE=$((16#$ST_MODE_RAW))
  else
    case "$ST_MODE_RAW" in
      ''|*[!0-7]*) return 1 ;;
    esac
    ST_MODE=$((8#$ST_MODE_RAW))
  fi
  return 0
}

# ---------------------------------------------------------------------------
# fs.*
# ---------------------------------------------------------------------------

# `..` of a path as the file tree understands it: `/` stays `/`, and a
# single-component relative path falls back to `.` — the helper's `parent_dir`,
# which is also the convention the shipping FARAGENT_DIRS_V1 script uses.
parent_dir() {
  local p="$1"
  # A trailing slash is not a component: `/a/b/` behaves as `/a/b`, so its
  # parent is `/a` — what `Path::parent` reads.
  while [ "${#p}" -gt 1 ]; do
    case "$p" in
      */) p=${p%/} ;;
      *) break ;;
    esac
  done
  case "$p" in
    */*)
      p=${p%/*}
      [ -n "$p" ] || p=/
      ;;
    *) p=. ;;
  esac
  printf '%s' "$p"
}

# Which of the four kinds the helper reports. Symlink first: the other tests
# follow the link.
kind_of() {
  if [ -L "$1" ]; then printf symlink
  elif [ -d "$1" ]; then printf dir
  elif [ -f "$1" ]; then printf file
  else printf other
  fi
}

# True when the first $2 bytes of $1 contain a NUL — the classic binary marker,
# and the one git itself uses. Invalid UTF-8 alone is not binary: a Latin-1
# source file should still preview.
sniff_is_binary() {
  local total clean
  total=$(head -c "$2" -- "$1" 2>/dev/null | wc -c | tr -d ' ')
  clean=$(head -c "$2" -- "$1" 2>/dev/null | tr -d '\000' | wc -c | tr -d ' ')
  [ "$total" != "$clean" ]
}

# True when $3 bytes from offset $2 on contain a NUL. Only consulted when the
# chunk reaches past the sniffed head: a chunk from the middle of an archive
# carries no NUL at offset 0, which is exactly what the head sniff cannot see.
chunk_is_binary() {
  local total clean
  total=$(tail -c "+$(( $2 + 1 ))" -- "$1" 2>/dev/null | head -c "$3" | wc -c | tr -d ' ')
  clean=$(tail -c "+$(( $2 + 1 ))" -- "$1" 2>/dev/null | head -c "$3" | tr -d '\000' | wc -c | tr -d ' ')
  [ "$total" != "$clean" ]
}

# The base64 of $3 bytes of $1 starting at byte offset $2. Only base64 ever
# enters a shell variable: a raw chunk could hold a NUL, and no shell variable
# can.
read_chunk_b64() {
  tail -c "+$(( $2 + 1 ))" -- "$1" 2>/dev/null | head -c "$3" | base64 2>/dev/null | tr -d '\n'
}

op_fs_stat() {
  local id="$1" p="$2" b64p="$3" kind islink=false
  if ! stat_path 0 "$p"; then
    if [ ! -e "$p" ] && [ ! -L "$p" ]; then
      emit_error "$id" not_found "no such path: $p"
    else
      emit_error "$id" unreadable "cannot stat $p"
    fi
    return 0
  fi
  kind=$(kind_of "$p")
  if [ "$kind" = symlink ]; then islink=true; fi
  emit_data "$id" "{\"path_b64\":\"$b64p\",\"kind\":\"$kind\",\"size\":$ST_SIZE,\"mtime\":$ST_MTIME,\"mode\":$ST_MODE,\"is_symlink\":$islink}"
}

op_fs_list() {
  local id="$1" p="$2" b64p="$3" parent
  if ! stat_path 0 "$p"; then
    if [ ! -e "$p" ] && [ ! -L "$p" ]; then
      emit_error "$id" not_found "no such path: $p"
    else
      emit_error "$id" unreadable "cannot stat $p"
    fi
    return 0
  fi
  # `[ -d ]` follows a symlink, which is what the helper's ls-like listing does
  # for a symlinked directory — and what makes a symlink to a *file* not_a_dir
  # rather than a listing.
  if [ ! -d "$p" ]; then
    emit_error "$id" not_a_dir "not a directory: $p"
    return 0
  fi
  if [ ! -r "$p" ] || [ ! -x "$p" ]; then
    emit_error "$id" unreadable "cannot read directory: $p"
    return 0
  fi
  local entries='' sep='' count=0 truncated=false
  local f name kind size mtime islink
  # Pathname expansion yields one word per match whatever the name contains —
  # spaces, newlines, quotes, a literal `*` (quoting of the expanded directory
  # keeps its own metacharacters literal) — and no word is ever re-split. The
  # two dot patterns are every dotfile: `.[!.]*` misses nothing that `..?*`
  # then catches, and neither matches `.` or `..`.
  #
  # Expansion sorts one pattern's matches, not all three's, so the dotfiles
  # would arrive after every other name — where the helper sorts the whole
  # listing by raw name bytes. The three already-sorted runs are therefore
  # merged back into one order by an insertion sort, which on this
  # nearly-sorted input is O(n). A name may hold any byte but NUL, so the
  # names are held as array elements (any delimiter could occur inside one) and
  # compared with `[ > ]`, a byte comparison under the C locale pinned above.
  # Comparing full paths is the same order as comparing names, because every
  # path here shares the `$p/` prefix.
  local -a paths=("$p"/* "$p"/.[!.]* "$p"/..?*)
  local n=${#paths[@]} i=1 j key
  while [ "$i" -lt "$n" ]; do
    key=${paths[$i]}
    j=$((i - 1))
    while [ "$j" -ge 0 ] && [ "${paths[$j]}" \> "$key" ]; do
      paths[$((j + 1))]=${paths[$j]}
      j=$((j - 1))
    done
    paths[$((j + 1))]=$key
    i=$((i + 1))
  done
  for f in "${paths[@]}"; do
    if [ ! -e "$f" ] && [ ! -L "$f" ]; then continue; fi
    if [ "$count" -ge "$MAX_LIST_ENTRIES" ]; then truncated=true; break; fi
    name=${f##*/}
    kind=$(kind_of "$f")
    size=0
    mtime=0
    islink=false
    if [ "$kind" = symlink ]; then islink=true; fi
    if stat_path 0 "$f"; then
      mtime=$ST_MTIME
      if [ "$kind" = file ]; then size=$ST_SIZE; fi
    else
      kind=other
    fi
    entries="$entries$sep{\"name_b64\":\"$(b64 "$name")\",\"kind\":\"$kind\",\"size\":$size,\"mtime\":$mtime,\"is_symlink\":$islink}"
    sep=,
    count=$((count + 1))
  done
  parent=$(parent_dir "$p")
  emit_data "$id" "{\"path_b64\":\"$b64p\",\"parent_b64\":\"$(b64 "$parent")\",\"entries\":[$entries],\"truncated\":$truncated}"
}

# The helper's `fs::metadata(&path)`: the path itself must exist (a symlink
# whose target is gone does not), and the size and mode are the *target's*.
# Shell tests cannot tell "no such file" from "permission denied on a parent",
# so this is the one place the two implementations can disagree: an EACCES
# lookup answers not_found here where the helper answers unreadable.
op_fs_read() {
  local id="$1" p="$2" offset="$3" limit="$4" size data have eof=false
  if [ ! -e "$p" ]; then
    emit_error "$id" not_found "no such path: $p"
    return 0
  fi
  if ! stat_path 1 "$p"; then
    emit_error "$id" unreadable "cannot read $p"
    return 0
  fi
  if [ $(( ST_MODE & S_IFMT_DEC )) -ne "$S_IFREG_DEC" ]; then
    emit_error "$id" unreadable "not a regular file: $p"
    return 0
  fi
  size=$ST_SIZE
  if [ "$size" -gt "$MAX_FILE_BYTES" ]; then
    emit_error "$id" too_large "$p is $size bytes, more than the $MAX_FILE_BYTES byte preview limit"
    return 0
  fi
  if [ ! -r "$p" ]; then
    emit_error "$id" unreadable "permission denied: $p"
    return 0
  fi
  # Sniff the head of the file, not the requested chunk: a chunk from the
  # middle of an archive looks exactly like text.
  if [ "$size" -gt 0 ] && sniff_is_binary "$p" "$SNIFF_BYTES"; then
    emit_error "$id" binary "$p is a binary file ($size bytes)"
    return 0
  fi
  if [ "$offset" -gt "$size" ]; then offset=$size; fi
  data=$(read_chunk_b64 "$p" "$offset" "$limit")
  # The base64 length gives the byte count back exactly, so `eof` needs no
  # second read of the same bytes.
  have=$(( ${#data} / 4 * 3 ))
  case "$data" in
    *==) have=$((have - 2)) ;;
    *=) have=$((have - 1)) ;;
  esac
  if [ $((offset + have)) -gt "$SNIFF_BYTES" ] && chunk_is_binary "$p" "$offset" "$have"; then
    emit_error "$id" binary "$p is a binary file ($size bytes)"
    return 0
  fi
  if [ $((offset + have)) -ge "$size" ]; then eof=true; fi
  emit_data "$id" "{\"data_b64\":\"$data\",\"eof\":$eof,\"size\":$size}"
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

dispatch_fs_list() {
  local id="$1" line="$2"
  take_field "$id" "$line" path_b64 || return 0
  op_fs_list "$id" "$FIELD_BYTES" "$FIELD_B64"
}

dispatch_fs_stat() {
  local id="$1" line="$2"
  take_field "$id" "$line" path_b64 || return 0
  op_fs_stat "$id" "$FIELD_BYTES" "$FIELD_B64"
}

dispatch_fs_read() {
  local id="$1" line="$2" offset limit
  take_field "$id" "$line" path_b64 || return 0
  opt_u64 offset "$line"
  if [ "$OPT_BAD" = 1 ]; then
    emit_error "$id" bad_request "\`offset\` must be a non-negative integer"
    return 0
  fi
  if [ -n "$OPT_U64" ]; then offset=$OPT_U64; else offset=0; fi
  clamp_u64 "$offset" 0 "$MAX_FILE_BYTES"
  offset=$CLAMPED
  opt_u64 limit "$line"
  if [ "$OPT_BAD" = 1 ]; then
    emit_error "$id" bad_request "\`limit\` must be a non-negative integer"
    return 0
  fi
  if [ -n "$OPT_U64" ]; then limit=$OPT_U64; else limit=$DEFAULT_READ_LIMIT; fi
  clamp_u64 "$limit" 1 "$MAX_READ_CHUNK"
  limit=$CLAMPED
  op_fs_read "$id" "$FIELD_BYTES" "$offset" "$limit"
}

# The fallback speaks a subset of the helper's op set: ping and everything
# read-only that this script implements. A client that asks for the rest
# (`git.branches`, `git.diff`, `watch.*`, `shutdown`) gets a bad_request naming
# what is here, which is the honest answer and keeps it from waiting.
op_ping() {
  local id="$1"
  emit_data "$id" "{\"pong\":true,\"version\":\"@@VERSION@@\",\"pid\":$$,\"ops\":[\"ping\",\"fs.list\",\"fs.read\",\"fs.stat\",\"git.discover\",\"git.status\",\"git.log\"]}"
}

# Serve one line: a reply, or an error carrying whatever id could be read. A
# malformed line is answered, never fatal — the channel cannot fall out of step
# with a client that is counting replies. Note that the request reader is a
# lexical scanner, not a JSON parser: a frame with a syntax error in a field
# this script never looks at may still be served, where the helper would answer
# bad_request. Being more permissive here cannot corrupt a reply; it only means
# malformed requests are answered rather than refused.
serve_line() {
  local id op
  if [ "$HAVE_BASE64" != true ]; then
    emit_error "$(request_id "$1")" internal "this host has no \`base64\`; the fallback channel cannot encode a frame"
    return 0
  fi
  id=$(request_id "$1")
  op=$(request_op "$1")
  if [ -z "$op" ]; then
    emit_error "$id" bad_request "frame has no string \`op\`"
    return 0
  fi
  case "$op" in
    ping) op_ping "$id" ;;
    fs.list) dispatch_fs_list "$id" "$1" ;;
    fs.read) dispatch_fs_read "$id" "$1" ;;
    fs.stat) dispatch_fs_stat "$id" "$1" ;;
    git.discover | git.status | git.log) op_git_dispatch "$id" "$1" "$op" ;;
    *)
      emit_error "$id" bad_request "unknown op \`$op\`; this fallback speaks: ping, fs.list, fs.read, fs.stat, git.discover, git.status, git.log"
      ;;
  esac
}
"#;
