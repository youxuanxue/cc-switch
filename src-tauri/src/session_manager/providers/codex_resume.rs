use toml_edit::{DocumentMut, Item};

use crate::codex_config::is_custom_codex_model_provider_id;
use crate::session_manager::terminal::shell_escape;

/// Live configuration is deliberately separate from cached rollout metadata.
pub(super) struct ResumeConfig(DocumentMut);

impl ResumeConfig {
    pub(super) fn parse(text: &str) -> Option<Self> {
        text.parse().ok().map(Self)
    }

    fn defines(&self, id: &str) -> bool {
        !id.trim().is_empty()
            && ((id == id.trim() && !is_custom_codex_model_provider_id(id))
                || self
                    .0
                    .get("model_providers")
                    .and_then(|providers| providers.get(id))
                    .and_then(Item::as_table_like)
                    .is_some())
    }

    fn fallback_for(&self, previous: &str) -> Option<&str> {
        if previous.trim().is_empty() || self.defines(previous) {
            return None;
        }
        let active = match self.0.get("model_provider") {
            Some(item) => item.as_str()?,
            None => "openai",
        };
        self.defines(active).then_some(active)
    }
}

pub(super) fn resume_command(
    session_id: &str,
    previous_provider: Option<&str>,
    config: Option<&ResumeConfig>,
) -> String {
    let command = format!("codex resume {session_id}");
    let fallback = previous_provider.and_then(|previous| config?.fallback_for(previous));
    match fallback {
        Some(provider) => {
            // Two encodings: a TOML string for Codex, then one shell argument.
            let setting = format!("model_provider={}", toml_edit::Value::from(provider));
            format!("{command} -c {}", shell_escape(&setting))
        }
        None => command,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_provider_uses_current_config_not_a_hardcoded_id() {
        for active in ["custom", "company-relay", "openai", "OpenAI"] {
            let config = ResumeConfig::parse(&format!(
                "model_provider = {active:?}\n[model_providers.{active}]\nname = 'Relay'"
            ))
            .unwrap();
            assert_eq!(
                resume_command("thread-1", Some("tokenkey"), Some(&config)),
                format!("codex resume thread-1 -c 'model_provider=\"{active}\"'")
            );
        }
    }

    #[test]
    fn existing_builtin_and_unknown_session_providers_keep_native_resume() {
        let config = ResumeConfig::parse(
            "model_provider = 'custom'\nmodel_providers = { custom = { name = 'Relay' }, tokenkey = { name = 'Old' } }",
        )
        .unwrap();
        for previous in [
            None,
            Some(""),
            Some("tokenkey"),
            Some("custom"),
            Some("openai"),
            Some("ollama"),
            Some("lmstudio"),
        ] {
            assert_eq!(
                resume_command("thread-1", previous, Some(&config)),
                "codex resume thread-1"
            );
        }
    }

    #[test]
    fn unavailable_or_invalid_configuration_does_not_guess_a_provider() {
        for text in [
            "[",
            "model_provider = 7",
            "model_provider = ''",
            "model_provider = '   '",
            "model_provider = ' openai '",
            "model_provider = 'missing'",
            "model_provider = 'custom'\nmodel_providers.custom = false",
        ] {
            let config = ResumeConfig::parse(text);
            assert_eq!(
                resume_command("thread-1", Some("tokenkey"), config.as_ref()),
                "codex resume thread-1"
            );
        }
        assert_eq!(
            resume_command("thread-1", Some("tokenkey"), None),
            "codex resume thread-1"
        );
    }

    #[test]
    fn config_without_explicit_provider_uses_codex_builtin_default() {
        let config = ResumeConfig::parse("").unwrap();
        assert_eq!(
            resume_command("thread-1", Some("tokenkey"), Some(&config)),
            "codex resume thread-1 -c 'model_provider=\"openai\"'"
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_override_survives_shell_and_toml_parsing_literally() {
        let provider = "team's \"relay\" $(echo expanded) `echo expanded` \\ $HOME";
        let mut doc = DocumentMut::new();
        doc["model_provider"] = toml_edit::value(provider);
        doc["model_providers"][provider]["name"] = toml_edit::value("Relay");
        let config = ResumeConfig::parse(&doc.to_string()).unwrap();
        let command = resume_command("thread-1", Some("tokenkey"), Some(&config));
        let output = std::process::Command::new("sh")
            .args([
                "-c",
                &format!("codex() {{ printf '%s\\n' \"$@\"; }}; {command}"),
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        let stdout = String::from_utf8(output.stdout).unwrap();
        let args: Vec<_> = stdout.lines().collect();
        assert_eq!(&args[..3], &["resume", "thread-1", "-c"]);
        assert_eq!(args.len(), 4);
        let override_doc: DocumentMut = args[3].parse().unwrap();
        assert_eq!(override_doc["model_provider"].as_str(), Some(provider));
    }
}
