use std::io::Write;

use crate::database::Database;
use crate::error::AppError;

use super::{
    agents_add, agents_remove, doctor, doctor_json, follow_catalog, import_paths, install, open,
    sync, uninstall, upgrade,
};

pub fn run_cli(args: &[String], stdout: &mut impl Write, stderr: &mut impl Write) -> i32 {
    match run_cli_inner(args, stdout, stderr) {
        Ok(code) => code,
        Err(err) => {
            let _ = writeln!(stderr, "{err}");
            1
        }
    }
}

fn run_cli_inner(
    args: &[String],
    stdout: &mut impl Write,
    stderr: &mut impl Write,
) -> Result<i32, AppError> {
    let args = if args.first().map(String::as_str) == Some("skills") {
        &args[1..]
    } else {
        args
    };
    if args.is_empty() {
        return Err(AppError::InvalidInput(
            "用法: cc-switch skills <open|sync|install|uninstall|import|upgrade|follow-catalog|agents|doctor>"
                .into(),
        ));
    }
    let db = Database::init()?;
    match args[0].as_str() {
        "open" => {
            let (agents, skills) = parse_open_flags(&args[1..])?;
            open(&db, &agents, &skills)?;
            Ok(0)
        }
        "sync" => {
            let check = args[1..].iter().any(|a| a == "--check");
            if check {
                let report = sync(&db, true)?;
                writeln!(
                    stdout,
                    "{}",
                    serde_json::to_string_pretty(&report)
                        .map_err(|e| AppError::JsonSerialize { source: e })?
                )
                .map_err(|e| AppError::Message(e.to_string()))?;
                Ok(0)
            } else {
                sync(&db, false)?;
                Ok(0)
            }
        }
        "install" => {
            require_names(&args[1..], "install")?;
            install(&db, &args[1..])?;
            Ok(0)
        }
        "uninstall" => {
            require_names(&args[1..], "uninstall")?;
            uninstall(&db, &args[1..])?;
            Ok(0)
        }
        "import" => {
            require_names(&args[1..], "import")?;
            let paths = args[1..]
                .iter()
                .map(std::path::PathBuf::from)
                .collect::<Vec<_>>();
            import_paths(&db, &paths)?;
            Ok(0)
        }
        "upgrade" => {
            let name = args.get(1).cloned();
            upgrade(&db, name)?;
            Ok(0)
        }
        "follow-catalog" => {
            let mode = args.get(1).map(String::as_str).unwrap_or("");
            let on = match mode {
                "on" => true,
                "off" => false,
                _ => {
                    return Err(AppError::InvalidInput(
                        "用法: cc-switch skills follow-catalog on|off".into(),
                    ))
                }
            };
            follow_catalog(&db, on)?;
            Ok(0)
        }
        "agents" => {
            let action = args.get(1).map(String::as_str).unwrap_or("");
            let token = args.get(2).cloned().ok_or_else(|| {
                AppError::InvalidInput("用法: cc-switch skills agents add|remove <token>".into())
            })?;
            match action {
                "add" => agents_add(&db, &token)?,
                "remove" => agents_remove(&db, &token)?,
                _ => {
                    return Err(AppError::InvalidInput(
                        "用法: cc-switch skills agents add|remove <token>".into(),
                    ))
                }
            }
            Ok(0)
        }
        "doctor" => {
            let json = args[1..].iter().any(|a| a == "--json");
            let report = doctor(&db)?;
            if json {
                writeln!(stdout, "{}", doctor_json(&db)?)
                    .map_err(|e| AppError::Message(e.to_string()))?;
            } else {
                writeln!(
                    stdout,
                    "open={} library={}",
                    report.open,
                    report.library.len()
                )
                .map_err(|e| AppError::Message(e.to_string()))?;
            }
            let unsafe_proj = report.open
                && (!report.broken.is_empty()
                    || !report.duplicate.is_empty()
                    || report.projections.iter().any(|p| !p.aligned));
            if unsafe_proj {
                let _ = writeln!(stderr, "doctor: 投影不安全");
                Ok(1)
            } else {
                Ok(0)
            }
        }
        other => Err(AppError::InvalidInput(format!("未知子命令: {other}"))),
    }
}

fn require_names(args: &[String], cmd: &str) -> Result<(), AppError> {
    if args.is_empty() {
        return Err(AppError::InvalidInput(format!(
            "用法: cc-switch skills {cmd} <name>..."
        )));
    }
    Ok(())
}

fn parse_open_flags(args: &[String]) -> Result<(Vec<String>, Vec<String>), AppError> {
    let mut agents = Vec::new();
    let mut skills = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--agent" => {
                let value = args
                    .get(i + 1)
                    .ok_or_else(|| AppError::InvalidInput("open --agent 需要 token".into()))?;
                agents.push(value.clone());
                i += 2;
            }
            "--skill" => {
                let value = args
                    .get(i + 1)
                    .ok_or_else(|| AppError::InvalidInput("open --skill 需要 name".into()))?;
                skills.push(value.clone());
                i += 2;
            }
            other => return Err(AppError::InvalidInput(format!("open 未知参数: {other}"))),
        }
    }
    Ok((agents, skills))
}
