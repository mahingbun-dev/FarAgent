use crate::agents::AgentKind;
use crate::config;
use crate::i18n::Lang;
use crate::probe::{self, Probe};
use crate::pty;
use crate::runtime::{self, SessionSummary};
use crate::ssh::{self, SshHost};
use anyhow::Result;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::{DefaultTerminal, Frame};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone)]
enum Screen {
    Language,
    Hosts,
    Agents,
    Sessions,
    NewCwd,
}

struct App {
    screen: Screen,
    lang: Lang,
    lang_idx: usize,
    hosts: Vec<SshHost>,
    host_idx: usize,
    agent_idx: usize,
    session_idx: usize,
    probe: Option<Probe>,
    sessions: Vec<SessionSummary>,
    cwd_input: String,
    status: String,
    error: Option<String>,
    quit: bool,
}

impl App {
    fn new(hosts: Vec<SshHost>, saved: Option<Lang>) -> Self {
        let (screen, lang, lang_idx, status) = match saved {
            Some(lang) => {
                let idx = Lang::ALL.iter().position(|l| *l == lang).unwrap_or(0);
                (Screen::Hosts, lang, idx, lang.status_ready().to_string())
            }
            None => (
                Screen::Language,
                Lang::Zh,
                0,
                Lang::Zh.language_keys_hint().to_string(),
            ),
        };
        Self {
            screen,
            lang,
            lang_idx,
            hosts,
            host_idx: 0,
            agent_idx: 0,
            session_idx: 0,
            probe: None,
            sessions: Vec::new(),
            cwd_input: String::new(),
            status,
            error: None,
            quit: false,
        }
    }

    fn host(&self) -> Option<&SshHost> {
        self.hosts.get(self.host_idx)
    }

    fn agent(&self) -> AgentKind {
        AgentKind::ALL[self.agent_idx.min(3)]
    }

    fn clamp(&mut self) {
        if !self.hosts.is_empty() {
            self.host_idx = self.host_idx.min(self.hosts.len() - 1);
        }
        self.agent_idx = self.agent_idx.min(3);
        self.lang_idx = self.lang_idx.min(Lang::ALL.len().saturating_sub(1));
        if !self.sessions.is_empty() {
            self.session_idx = self.session_idx.min(self.sessions.len() - 1);
        } else {
            self.session_idx = 0;
        }
    }

    fn move_sel(&mut self, delta: i32) {
        match self.screen {
            Screen::Language => {
                let n = Lang::ALL.len() as i32;
                self.lang_idx = (self.lang_idx as i32 + delta).rem_euclid(n) as usize;
            }
            Screen::Hosts => {
                if self.hosts.is_empty() {
                    return;
                }
                let n = self.hosts.len() as i32;
                self.host_idx = (self.host_idx as i32 + delta).rem_euclid(n) as usize;
            }
            Screen::Agents => {
                self.agent_idx = (self.agent_idx as i32 + delta).rem_euclid(4) as usize;
            }
            Screen::Sessions => {
                if self.sessions.is_empty() {
                    return;
                }
                let n = self.sessions.len() as i32;
                self.session_idx = (self.session_idx as i32 + delta).rem_euclid(n) as usize;
            }
            Screen::NewCwd => {}
        }
    }
}

pub fn run() -> Result<()> {
    let hosts = ssh::list_hosts()?;
    let mut app = App::new(hosts, config::language());
    if matches!(app.screen, Screen::Hosts) && app.hosts.is_empty() {
        app.status = app.lang.no_hosts().into();
    }
    let mut terminal = ratatui::init();
    let result = event_loop(&mut terminal, &mut app);
    ratatui::restore();
    result
}

fn event_loop(terminal: &mut DefaultTerminal, app: &mut App) -> Result<()> {
    while !app.quit {
        terminal.draw(|f| draw(f, app))?;
        if !event::poll(Duration::from_millis(200))? {
            continue;
        }
        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        handle_key(app, key, terminal)?;
    }
    Ok(())
}

fn handle_key(app: &mut App, key: KeyEvent, terminal: &mut DefaultTerminal) -> Result<()> {
    if matches!(app.screen, Screen::NewCwd) {
        return handle_cwd_key(app, key, terminal);
    }
    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => match app.screen {
            Screen::Language | Screen::Hosts => app.quit = true,
            Screen::Agents => {
                app.screen = Screen::Hosts;
                app.probe = None;
                app.status = app.lang.status_ready().into();
            }
            Screen::Sessions => {
                app.screen = Screen::Agents;
                app.status = app.lang.select_agent().into();
            }
            Screen::NewCwd => {}
        },
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => app.quit = true,
        KeyCode::Down | KeyCode::Char('j') => app.move_sel(1),
        KeyCode::Up | KeyCode::Char('k') => app.move_sel(-1),
        KeyCode::Char('r') => refresh(app)?,
        KeyCode::Char('l') | KeyCode::Char('L')
            if matches!(app.screen, Screen::Hosts | Screen::Language) =>
        {
            begin_language(app);
        }
        KeyCode::Char('?') => {
            app.status = app.lang.status_help().into();
        }
        KeyCode::Char('n') if matches!(app.screen, Screen::Sessions) => begin_new(app),
        KeyCode::Enter => on_enter(app, terminal)?,
        _ => {}
    }
    Ok(())
}

fn handle_cwd_key(app: &mut App, key: KeyEvent, terminal: &mut DefaultTerminal) -> Result<()> {
    match key.code {
        KeyCode::Esc => {
            app.screen = Screen::Sessions;
            app.status = app.lang.cancelled().into();
        }
        KeyCode::Backspace => {
            app.cwd_input.pop();
        }
        KeyCode::Enter => {
            let cwd = app.cwd_input.trim().to_string();
            if cwd.is_empty() {
                app.error = Some(app.lang.cwd_required().into());
                return Ok(());
            }
            let host = app.host().map(|h| h.alias.clone());
            let Some(host) = host else {
                return Ok(());
            };
            let agent = app.agent();
            attach_new(app, terminal, &host, agent, PathBuf::from(cwd))?;
        }
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.cwd_input.push(c);
        }
        _ => {}
    }
    Ok(())
}

fn begin_language(app: &mut App) {
    app.lang_idx = Lang::ALL.iter().position(|l| *l == app.lang).unwrap_or(0);
    app.screen = Screen::Language;
    app.error = None;
    app.status = app.lang.language_keys_hint().into();
}

fn commit_language(app: &mut App) -> Result<()> {
    let lang = Lang::ALL[app.lang_idx.min(Lang::ALL.len() - 1)];
    match config::set_language(lang) {
        Ok(()) => {
            app.lang = lang;
            app.screen = Screen::Hosts;
            app.error = None;
            app.status = if app.hosts.is_empty() {
                lang.no_hosts().into()
            } else {
                lang.language_saved()
            };
        }
        Err(e) => {
            app.error = Some(lang.language_save_failed(&e.to_string()));
        }
    }
    Ok(())
}

fn begin_new(app: &mut App) {
    let Some(probe) = &app.probe else {
        app.error = Some(app.lang.probe_host_first().into());
        return;
    };
    if !probe.tmux.found {
        app.error = Some(app.lang.tmux_missing_short().into());
        return;
    }
    if probe.agent(app.agent()).map(|a| a.found) != Some(true) {
        app.error = Some(app.lang.agent_missing(&app.agent().to_string()));
        return;
    }
    app.cwd_input = app
        .sessions
        .iter()
        .find_map(|s| s.cwd.clone())
        .unwrap_or_else(|| probe.home.clone());
    app.screen = Screen::NewCwd;
    app.status = app.lang.type_cwd().into();
}

fn refresh(app: &mut App) -> Result<()> {
    match app.screen {
        Screen::Language => {}
        Screen::Hosts => {
            app.hosts = ssh::list_hosts()?;
            app.status = app.lang.host_count(app.hosts.len());
        }
        Screen::Agents | Screen::Sessions | Screen::NewCwd => reload_probe_and_sessions(app)?,
    }
    app.clamp();
    Ok(())
}

fn on_enter(app: &mut App, terminal: &mut DefaultTerminal) -> Result<()> {
    match app.screen {
        Screen::Language => commit_language(app)?,
        Screen::Hosts => {
            let Some(host) = app.host().map(|h| h.alias.clone()) else {
                return Ok(());
            };
            app.status = app.lang.probing(&host);
            app.error = None;
            terminal.draw(|f| draw(f, app))?;
            match probe::probe_host(&host) {
                Ok(p) => {
                    app.probe = Some(p);
                    app.screen = Screen::Agents;
                    app.agent_idx = 0;
                    app.error = None;
                    app.status = app.lang.select_agent().into();
                }
                Err(e) => {
                    app.status = app.lang.probe_failed(&host);
                    app.error = Some(e.to_string());
                }
            }
        }
        Screen::Agents => {
            let Some(probe) = &app.probe else {
                return Ok(());
            };
            if probe.agent(app.agent()).map(|a| a.found) != Some(true) {
                app.error = Some(app.lang.agent_not_installed(&app.agent().to_string()));
                return Ok(());
            }
            if !probe.tmux.found {
                app.error = Some(app.lang.tmux_missing().into());
                return Ok(());
            }
            reload_sessions(app)?;
            app.screen = Screen::Sessions;
            app.session_idx = 0;
            app.status = app.lang.sessions_status().into();
        }
        Screen::Sessions => {
            if app.sessions.is_empty() {
                begin_new(app);
                return Ok(());
            }
            attach_existing(app, terminal)?;
        }
        Screen::NewCwd => {}
    }
    Ok(())
}

fn reload_probe_and_sessions(app: &mut App) -> Result<()> {
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return Ok(());
    };
    match probe::probe_host(&host) {
        Ok(p) => {
            app.probe = Some(p);
            app.error = None;
        }
        Err(e) => {
            app.status = app.lang.probe_failed(&host);
            app.error = Some(e.to_string());
            return Ok(());
        }
    }
    if matches!(app.screen, Screen::Sessions | Screen::NewCwd) {
        reload_sessions(app)?;
    }
    Ok(())
}

fn reload_sessions(app: &mut App) -> Result<()> {
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return Ok(());
    };
    match runtime::list_sessions(&host, app.agent()) {
        Ok(rows) => {
            app.sessions = rows;
            app.error = None;
            app.status = app.lang.session_count(app.sessions.len());
        }
        Err(e) => app.error = Some(e.to_string()),
    }
    Ok(())
}

fn attach_existing(app: &mut App, terminal: &mut DefaultTerminal) -> Result<()> {
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return Ok(());
    };
    let Some(sess) = app.sessions.get(app.session_idx).cloned() else {
        return Ok(());
    };
    let agent = app.agent();
    let cwd = sess
        .cwd
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| app.probe.as_ref().map(|p| PathBuf::from(&p.home)))
        .unwrap_or_else(|| PathBuf::from("."));
    // Live tmux: attach only. Never resume a running session (Codex #30424).
    let tmux = if sess.live {
        sess.tmux
            .clone()
            .unwrap_or_else(|| crate::agents::tmux_name(agent, &sess.id))
    } else {
        runtime::ensure_tmux_session(&host, agent, &cwd, Some(&sess.id))?
    };
    drop_into_tmux(app, terminal, &host, &tmux)
}

fn attach_new(
    app: &mut App,
    terminal: &mut DefaultTerminal,
    host: &str,
    agent: AgentKind,
    cwd: PathBuf,
) -> Result<()> {
    match runtime::ensure_tmux_session(host, agent, &cwd, None) {
        Ok(tmux) => {
            app.screen = Screen::Sessions;
            drop_into_tmux(app, terminal, host, &tmux)?;
        }
        Err(e) => {
            app.error = Some(e.to_string());
            app.screen = Screen::Sessions;
        }
    }
    Ok(())
}

fn drop_into_tmux(
    app: &mut App,
    terminal: &mut DefaultTerminal,
    host: &str,
    tmux_name: &str,
) -> Result<()> {
    app.status = app.lang.attaching(tmux_name);
    ratatui::restore();
    let code = pty::attach_tmux(host, tmux_name);
    *terminal = ratatui::init();
    match code {
        Ok(0) | Ok(1) => {
            // ssh/tmux often exit 1 on detach; still refresh.
            app.status = app.lang.detached().into();
            app.error = None;
        }
        Ok(c) => app.status = app.lang.ssh_exited(c),
        Err(e) => app.error = Some(e.to_string()),
    }
    let _ = reload_sessions(app);
    Ok(())
}

fn session_line(lang: Lang, s: &SessionSummary) -> String {
    let mark = if s.live { lang.live() } else { lang.idle() };
    let title = s
        .title
        .as_deref()
        .filter(|t| !t.is_empty())
        .unwrap_or(&s.id);
    let cwd = s.cwd.as_deref().unwrap_or("?");
    format!("[{mark}]  {title}  ({cwd})")
}

fn draw(frame: &mut Frame, app: &App) {
    let footer_h = if app.error.is_some() { 8 } else { 5 };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(footer_h),
        ])
        .split(frame.area());

    let title = match app.screen {
        Screen::Language => app.lang.language_title().to_string(),
        Screen::Hosts => app.lang.hosts_title().to_string(),
        Screen::Agents => app
            .lang
            .agents_title(app.host().map(|h| h.alias.as_str()).unwrap_or("?")),
        Screen::Sessions => app.lang.sessions_title(
            app.host().map(|h| h.alias.as_str()).unwrap_or("?"),
            app.agent().title(),
        ),
        Screen::NewCwd => app.lang.new_cwd_title().into(),
    };
    let header = Paragraph::new(title).block(
        Block::default()
            .borders(Borders::ALL)
            .style(Style::default().fg(Color::Cyan)),
    );
    frame.render_widget(header, chunks[0]);

    match app.screen {
        Screen::Language => {
            let lines: Vec<String> = Lang::ALL
                .iter()
                .map(|l| format!("{}  ({})", l.native_name(), l.code()))
                .collect();
            draw_list(
                frame,
                chunks[1],
                app.lang.language_list_title(),
                &lines,
                app.lang_idx,
            );
        }
        Screen::Hosts => draw_list(
            frame,
            chunks[1],
            app.lang.hosts_list_title(),
            &app.hosts.iter().map(|h| h.label()).collect::<Vec<_>>(),
            app.host_idx,
        ),
        Screen::Agents => {
            let probe = app.probe.as_ref();
            let lines: Vec<String> = AgentKind::ALL
                .iter()
                .map(|k| match probe {
                    Some(p) => probe::format_agent_line_lang(*k, p, app.lang),
                    None => k.title().to_string(),
                })
                .collect();
            draw_list(
                frame,
                chunks[1],
                app.lang.agents_list_title(),
                &lines,
                app.agent_idx,
            );
        }
        Screen::Sessions => {
            let lines: Vec<String> = if app.sessions.is_empty() {
                vec![app.lang.no_sessions().into()]
            } else {
                app.sessions
                    .iter()
                    .map(|s| session_line(app.lang, s))
                    .collect()
            };
            let idx = if app.sessions.is_empty() {
                0
            } else {
                app.session_idx
            };
            draw_list(
                frame,
                chunks[1],
                app.lang.sessions_list_title(),
                &lines,
                idx,
            );
        }
        Screen::NewCwd => {
            let p = Paragraph::new(format!("cwd> {}_", app.cwd_input)).block(
                Block::default()
                    .title(app.lang.cwd_block_title())
                    .borders(Borders::ALL),
            );
            frame.render_widget(p, chunks[1]);
        }
    }

    let mut footer_lines = vec![Line::from(app.status.clone())];
    let hint = match app.screen {
        Screen::Language => app.lang.language_keys_hint(),
        _ => app.lang.keys_hint(),
    };
    footer_lines.push(Line::from(Span::styled(
        hint,
        Style::default().fg(Color::DarkGray),
    )));
    if let Some(err) = &app.error {
        footer_lines.push(Line::from(Span::styled(
            err.clone(),
            Style::default().fg(Color::Red),
        )));
    }
    let footer = Paragraph::new(footer_lines)
        .wrap(Wrap { trim: true })
        .block(Block::default().borders(Borders::ALL));
    frame.render_widget(footer, chunks[2]);
}

fn draw_list(
    frame: &mut Frame,
    area: ratatui::layout::Rect,
    title: &str,
    items: &[String],
    idx: usize,
) {
    let list_items: Vec<ListItem> = items.iter().map(|s| ListItem::new(s.as_str())).collect();
    let list = List::new(list_items)
        .block(Block::default().title(title).borders(Borders::ALL))
        .highlight_style(
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("▸ ");
    let mut state = ListState::default();
    if !items.is_empty() {
        state.select(Some(idx.min(items.len() - 1)));
    }
    frame.render_stateful_widget(list, area, &mut state);
}
