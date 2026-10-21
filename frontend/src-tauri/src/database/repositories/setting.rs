use crate::database::models::{Setting, TranscriptSetting};
use crate::summary::CustomOpenAIConfig;
use sqlx::SqlitePool;

#[derive(serde::Deserialize, Debug)]
pub struct SaveTranscriptConfigRequest {
    pub provider: String,
    pub model: String,
    #[serde(rename = "apiKey")]
    pub api_key: Option<String>,
}

pub struct SettingsRepository;

// Transcript providers: localWhisper, deepgram, elevenLabs, groq, openai
// Summary providers: openai, claude, ollama, groq, added openrouter
// NOTE: Handle data exclusion in the higher layer as this is database abstraction layer(using SELECT *)

impl SettingsRepository {
    pub async fn get_model_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<Setting>, sqlx::Error> {
        let setting = sqlx::query_as::<_, Setting>("SELECT * FROM settings LIMIT 1")
            .fetch_optional(pool)
            .await?;
        Ok(setting)
    }

    pub async fn save_ai_model(
        pool: &SqlitePool,
        provider: &str,
        model: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel)
            VALUES ('1', $1, $2, 'large-v3')
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                model = excluded.model
            "#,
        )
        .bind(provider)
        .bind(model)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn save_ollama_endpoint(
        pool: &SqlitePool,
        endpoint: Option<&str>,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, ollamaEndpoint)
            VALUES ('1', 'builtin-ai', '', 'large-v3', $1)
            ON CONFLICT(id) DO UPDATE SET
                ollamaEndpoint = excluded.ollamaEndpoint
            "#,
        )
        .bind(endpoint)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn save_api_key(
        pool: &SqlitePool,
        provider: &str,
        api_key: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        // Custom OpenAI uses JSON config (customOpenAIConfig) instead of a separate API key column
        if provider == "custom-openai" {
            return Err(sqlx::Error::Protocol(
                "custom-openai provider should use save_custom_openai_config() instead of save_api_key()".into(),
            ));
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "claude" => "anthropicApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(()), // No API key needed
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, "{}")
            VALUES ('1', 'builtin-ai', '', 'large-v3', $1)
            ON CONFLICT(id) DO UPDATE SET
                "{}" = $1
            "#,
            api_key_column, api_key_column
        );
        sqlx::query(&query).bind(api_key).execute(pool).await?;

        Ok(())
    }

    pub async fn get_api_key(
        pool: &SqlitePool,
        provider: &str,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        // Custom OpenAI uses JSON config - extract API key from there
        if provider == "custom-openai" {
            let config = Self::get_custom_openai_config(pool).await?;
            return Ok(config.and_then(|c| c.api_key));
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "claude" => "anthropicApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" | "claude-code" | "codex" => return Ok(None), // No API key needed
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            "SELECT {} FROM settings WHERE id = '1' LIMIT 1",
            api_key_column
        );
        let api_key = sqlx::query_scalar(&query).fetch_optional(pool).await?;
        Ok(api_key)
    }

    pub async fn get_transcript_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<TranscriptSetting>, sqlx::Error> {
        let setting =
            sqlx::query_as::<_, TranscriptSetting>("SELECT * FROM transcript_settings LIMIT 1")
                .fetch_optional(pool)
                .await?;
        Ok(setting)

    }

    pub async fn save_transcript_config(
        pool: &SqlitePool,
        provider: &str,
        model: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        sqlx::query(
            r#"
            INSERT INTO transcript_settings (id, provider, model)
            VALUES ('1', $1, $2)
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                model = excluded.model
            "#,
        )
        .bind(provider)
        .bind(model)
        .execute(pool)
        .await?;

        Ok(())
    }

    pub async fn save_transcript_api_key(
        pool: &SqlitePool,
        provider: &str,
        api_key: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        let api_key_column = match provider {
            "localWhisper" => "whisperApiKey",
            "parakeet" => return Ok(()), // Parakeet doesn't need an API key, return early
            "deepgram" => "deepgramApiKey",
            "elevenLabs" => "elevenLabsApiKey",
            "groq" => "groqApiKey",
            "openai" => "openaiApiKey",
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            r#"
            INSERT INTO transcript_settings (id, provider, model, "{}")
            VALUES ('1', 'parakeet', '{}', $1)
            ON CONFLICT(id) DO UPDATE SET
                "{}" = $1
            "#,
            api_key_column, crate::config::DEFAULT_PARAKEET_MODEL, api_key_column
        );
        sqlx::query(&query).bind(api_key).execute(pool).await?;

        Ok(())
    }

    pub async fn get_transcript_api_key(
        pool: &SqlitePool,
        provider: &str,
    ) -> std::result::Result<Option<String>, sqlx::Error> {
        let api_key_column = match provider {
            "localWhisper" => "whisperApiKey",
            "parakeet" => return Ok(None), // Parakeet doesn't need an API key
            "openai-speech" | "openrouter-speech" => return Ok(None),
            "deepgram" => "deepgramApiKey",
            "elevenLabs" => "elevenLabsApiKey",
            "groq" => "groqApiKey",
            "openai" => "openaiApiKey",
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            "SELECT {} FROM transcript_settings WHERE id = '1' LIMIT 1",
            api_key_column
        );
        let api_key = sqlx::query_scalar(&query).fetch_optional(pool).await?;
        Ok(api_key)
    }

    pub async fn delete_api_key(
        pool: &SqlitePool,
        provider: &str,
    ) -> std::result::Result<(), sqlx::Error> {
        // Custom OpenAI uses JSON config - clear the entire config
        if provider == "custom-openai" {
            sqlx::query("UPDATE settings SET customOpenAIConfig = NULL WHERE id = '1'")
                .execute(pool)
                .await?;
            return Ok(());
        }

        let api_key_column = match provider {
            "openai" => "openaiApiKey",
            "ollama" => "ollamaApiKey",
            "groq" => "groqApiKey",
            "claude" => "anthropicApiKey",
            "openrouter" => "openRouterApiKey",
            "builtin-ai" => return Ok(()), // No API key needed
            _ => {
                return Err(sqlx::Error::Protocol(
                    format!("Invalid provider: {}", provider).into(),
                ))
            }
        };

        let query = format!(
            "UPDATE settings SET {} = NULL WHERE id = '1'",
            api_key_column
        );
        sqlx::query(&query).execute(pool).await?;

        Ok(())
    }

    // ===== CUSTOM OPENAI CONFIG METHODS =====

    /// Gets the custom OpenAI configuration from JSON
    ///
    /// # Returns
    /// * `Ok(Some(CustomOpenAIConfig))` - Config exists and is valid JSON
    /// * `Ok(None)` - No config stored
    /// * `Err(sqlx::Error)` - Database error
    pub async fn get_custom_openai_config(
        pool: &SqlitePool,
    ) -> std::result::Result<Option<CustomOpenAIConfig>, sqlx::Error> {
        use sqlx::Row;

        let row = sqlx::query(
            r#"
            SELECT customOpenAIConfig
            FROM settings
            WHERE id = '1'
            LIMIT 1
            "#
        )
        .fetch_optional(pool)
        .await?;

        match row {
            Some(record) => {
                let config_json: Option<String> = record.get("customOpenAIConfig");

                if let Some(json) = config_json {
                    // Parse JSON into CustomOpenAIConfig
                    let config: CustomOpenAIConfig = serde_json::from_str(&json)
                        .map_err(|e| sqlx::Error::Protocol(
                            format!("Invalid JSON in customOpenAIConfig: {}", e).into()
                        ))?;

                    Ok(Some(config))
                } else {
                    Ok(None)
                }
            }
            None => Ok(None),
        }
    }

    /// Saves the custom OpenAI configuration as JSON
    ///
    /// # Arguments
    /// * `pool` - Database connection pool
    /// * `config` - CustomOpenAIConfig to save (includes endpoint, apiKey, model, maxTokens, temperature, topP)
    ///
    /// # Returns
    /// * `Ok(())` - Config saved successfully
    /// * `Err(sqlx::Error)` - Database or JSON serialization error
    pub async fn save_custom_openai_config(
        pool: &SqlitePool,
        config: &CustomOpenAIConfig,
    ) -> std::result::Result<(), sqlx::Error> {
        // Serialize config to JSON
        let config_json = serde_json::to_string(config)
            .map_err(|e| sqlx::Error::Protocol(
                format!("Failed to serialize config to JSON: {}", e).into()
            ))?;

        // Upsert into settings table
        sqlx::query(
            r#"
            INSERT INTO settings (id, provider, model, whisperModel, customOpenAIConfig)
            VALUES ('1', 'builtin-ai', '', 'large-v3', $1)
            ON CONFLICT(id) DO UPDATE SET
                customOpenAIConfig = excluded.customOpenAIConfig,
                model = CASE WHEN provider = 'custom-openai' THEN $2 ELSE model END
            "#,
        )
        .bind(config_json)
        .bind(&config.model)
        .execute(pool)
        .await?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    fn custom(model: &str) -> CustomOpenAIConfig {
        CustomOpenAIConfig {
            endpoint: "http://box:8080/v1".to_string(),
            api_key: None,
            model: model.to_string(),
            max_tokens: None,
            temperature: None,
            top_p: None,
        }
    }

    #[tokio::test]
    async fn saving_a_key_on_empty_db_does_not_select_that_provider() {
        let pool = pool().await;
        SettingsRepository::save_api_key(&pool, "openai", "sk-1").await.unwrap();
        let s = SettingsRepository::get_model_config(&pool).await.unwrap().unwrap();
        assert_eq!(s.provider, "builtin-ai");
        assert_eq!(
            SettingsRepository::get_api_key(&pool, "openai").await.unwrap().as_deref(),
            Some("sk-1")
        );
    }

    #[tokio::test]
    async fn saving_the_ai_model_on_empty_db_creates_the_row() {
        let pool = pool().await;
        SettingsRepository::save_ai_model(&pool, "builtin-ai", "gemma3:1b").await.unwrap();
        let s = SettingsRepository::get_model_config(&pool).await.unwrap().unwrap();
        assert_eq!((s.provider.as_str(), s.model.as_str(), s.ollama_endpoint), ("builtin-ai", "gemma3:1b", None));
    }

    #[tokio::test]
    async fn saving_a_key_keeps_the_summary_model() {
        let pool = pool().await;
        SettingsRepository::save_ai_model(&pool, "ollama", "gemma3:1b").await.unwrap();
        SettingsRepository::save_api_key(&pool, "claude", "sk-ant").await.unwrap();
        let s = SettingsRepository::get_model_config(&pool).await.unwrap().unwrap();
        assert_eq!((s.provider.as_str(), s.model.as_str()), ("ollama", "gemma3:1b"));
    }

    #[tokio::test]
    async fn saving_the_summary_model_keeps_endpoint_and_keys() {
        let pool = pool().await;
        SettingsRepository::save_ollama_endpoint(&pool, Some("http://gpu:11434")).await.unwrap();
        SettingsRepository::save_api_key(&pool, "groq", "gsk").await.unwrap();
        SettingsRepository::save_ai_model(&pool, "claude", "claude-sonnet-4-5").await.unwrap();
        let s = SettingsRepository::get_model_config(&pool).await.unwrap().unwrap();
        assert_eq!(s.ollama_endpoint.as_deref(), Some("http://gpu:11434"));
        assert_eq!(
            SettingsRepository::get_api_key(&pool, "groq").await.unwrap().as_deref(),
            Some("gsk")
        );
    }

    #[tokio::test]
    async fn saving_the_endpoint_keeps_the_summary_model() {
        let pool = pool().await;
        SettingsRepository::save_ai_model(&pool, "openai", "gpt-4o").await.unwrap();
        SettingsRepository::save_ollama_endpoint(&pool, None).await.unwrap();
        let s = SettingsRepository::get_model_config(&pool).await.unwrap().unwrap();
        assert_eq!((s.provider.as_str(), s.model.as_str()), ("openai", "gpt-4o"));
        assert_eq!(s.ollama_endpoint, None);
    }

    #[tokio::test]
    async fn custom_server_model_follows_config_only_when_selected() {
        let pool = pool().await;
        SettingsRepository::save_ai_model(&pool, "openai", "gpt-4o").await.unwrap();
        SettingsRepository::save_custom_openai_config(&pool, &custom("llama3")).await.unwrap();
        let s = SettingsRepository::get_model_config(&pool).await.unwrap().unwrap();
        assert_eq!((s.provider.as_str(), s.model.as_str()), ("openai", "gpt-4o"));

        SettingsRepository::save_ai_model(&pool, "custom-openai", "llama3").await.unwrap();
        SettingsRepository::save_custom_openai_config(&pool, &custom("qwen3")).await.unwrap();
        let s = SettingsRepository::get_model_config(&pool).await.unwrap().unwrap();
        assert_eq!((s.provider.as_str(), s.model.as_str()), ("custom-openai", "qwen3"));
    }

    #[tokio::test]
    async fn deleting_a_key_keeps_others() {
        let pool = pool().await;
        SettingsRepository::save_api_key(&pool, "openai", "sk-1").await.unwrap();
        SettingsRepository::save_api_key(&pool, "claude", "sk-ant").await.unwrap();
        SettingsRepository::delete_api_key(&pool, "openai").await.unwrap();
        assert!(SettingsRepository::get_api_key(&pool, "openai").await.unwrap().unwrap_or_default().is_empty());
        assert_eq!(
            SettingsRepository::get_api_key(&pool, "claude").await.unwrap().as_deref(),
            Some("sk-ant")
        );
    }
}
