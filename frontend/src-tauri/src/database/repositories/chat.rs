use sqlx::{Row, Sqlite, SqlitePool, Transaction};

use crate::assistant::prompt::{ChatMessage, ChatRole};

pub struct MeetingChatRepository;

async fn insert_after_last(
    transaction: &mut Transaction<'_, Sqlite>,
    meeting_id: &str,
    messages: &[ChatMessage],
) -> Result<(), sqlx::Error> {
    let created_at = chrono::Utc::now().to_rfc3339();
    for message in messages {
        sqlx::query(
            "INSERT INTO meeting_chat_messages (meeting_id, position, role, text, error, created_at) SELECT ?, COALESCE(MAX(position), 0) + 1, ?, ?, ?, ? FROM meeting_chat_messages WHERE meeting_id = ?",
        )
        .bind(meeting_id)
        .bind(message.role.as_str())
        .bind(&message.text)
        .bind(message.error as i64)
        .bind(&created_at)
        .bind(meeting_id)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

impl MeetingChatRepository {
    pub async fn replace_for_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
        messages: &[ChatMessage],
    ) -> Result<(), sqlx::Error> {
        let mut transaction = pool.begin().await?;
        sqlx::query("DELETE FROM meeting_chat_messages WHERE meeting_id = ?")
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;
        insert_after_last(&mut transaction, meeting_id, messages).await?;
        transaction.commit().await
    }

    pub async fn append(
        pool: &SqlitePool,
        meeting_id: &str,
        messages: &[ChatMessage],
    ) -> Result<(), sqlx::Error> {
        let mut transaction = pool.begin().await?;
        insert_after_last(&mut transaction, meeting_id, messages).await?;
        transaction.commit().await
    }

    pub async fn has_recap(pool: &SqlitePool, meeting_id: &str) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM meeting_chat_messages WHERE meeting_id = ? AND role = ?)")
            .bind(meeting_id)
            .bind(ChatRole::Recap.as_str())
            .fetch_one(pool)
            .await
    }

    pub async fn append_recap_once(pool: &SqlitePool, meeting_id: &str, key_terms: Option<&str>, recap: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO meeting_chat_messages (meeting_id, position, role, text, error, created_at) \
             SELECT ?1, last.position + entry.offset, entry.role, entry.text, 0, ?2 \
             FROM (SELECT COALESCE(MAX(position), 0) AS position FROM meeting_chat_messages WHERE meeting_id = ?1) AS last \
             JOIN (SELECT 1 AS offset, ?3 AS role, ?4 AS text WHERE ?4 IS NOT NULL UNION ALL SELECT 2, ?5, ?6) AS entry \
             WHERE NOT EXISTS (SELECT 1 FROM meeting_chat_messages WHERE meeting_id = ?1 AND role = ?5) \
             ORDER BY entry.offset",
        )
        .bind(meeting_id)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(ChatRole::KeyTerms.as_str())
        .bind(key_terms)
        .bind(ChatRole::Recap.as_str())
        .bind(recap)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn set_key_terms(pool: &SqlitePool, meeting_id: &str, key_terms: &str) -> Result<bool, sqlx::Error> {
        let update = sqlx::query("UPDATE meeting_chat_messages SET text = ? WHERE meeting_id = ? AND role = ?")
            .bind(key_terms)
            .bind(meeting_id)
            .bind(ChatRole::KeyTerms.as_str())
            .execute(pool)
            .await?;
        Ok(update.rows_affected() > 0)
    }

    pub async fn delete_error(pool: &SqlitePool, meeting_id: &str, position: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM meeting_chat_messages WHERE meeting_id = ? AND position = ? AND error = 1")
            .bind(meeting_id)
            .bind(position)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn get_for_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Vec<ChatMessage>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT position, role, text, error FROM meeting_chat_messages WHERE meeting_id = ? ORDER BY position",
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| ChatMessage {
                id: format!("c{}", row.get::<i64, _>("position")),
                role: ChatRole::parse(row.get::<String, _>("role").as_str()),
                text: row.get("text"),
                error: row.get::<i64, _>("error") != 0,
                cards_note: false,
            })
            .collect())
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
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at) VALUES ('m1', 'Sync', '2026-10-14T10:00:00Z', '2026-10-14T10:00:00Z')")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    fn message(role: ChatRole, text: &str, error: bool) -> ChatMessage {
        ChatMessage { id: String::new(), role, text: text.to_string(), error, cards_note: false }
    }

    #[tokio::test]
    async fn call_chat_is_kept_and_follow_ups_continue_after_it() {
        let pool = pool().await;
        let call = [message(ChatRole::User, "Who owns it?", false), message(ChatRole::Assistant, "Nobody yet [01:10]", false)];
        MeetingChatRepository::replace_for_meeting(&pool, "m1", &call).await.unwrap();
        MeetingChatRepository::append(&pool, "m1", &[message(ChatRole::User, "Draft a follow-up", false)]).await.unwrap();
        MeetingChatRepository::append(&pool, "m1", &[message(ChatRole::Assistant, "Provider returned 401", true)]).await.unwrap();

        let chat = MeetingChatRepository::get_for_meeting(&pool, "m1").await.unwrap();
        let summary: Vec<(&str, ChatRole, &str, bool)> =
            chat.iter().map(|m| (m.id.as_str(), m.role, m.text.as_str(), m.error)).collect();
        assert_eq!(
            summary,
            vec![
                ("c1", ChatRole::User, "Who owns it?", false),
                ("c2", ChatRole::Assistant, "Nobody yet [01:10]", false),
                ("c3", ChatRole::User, "Draft a follow-up", false),
                ("c4", ChatRole::Assistant, "Provider returned 401", true),
            ]
        );
    }

    #[tokio::test]
    async fn the_meeting_recap_follows_the_chat_once() {
        let pool = pool().await;
        MeetingChatRepository::append(&pool, "m1", &[message(ChatRole::User, "Who owns it?", false)]).await.unwrap();
        assert!(!MeetingChatRepository::has_recap(&pool, "m1").await.unwrap());
        MeetingChatRepository::append_recap_once(&pool, "m1", Some("Terms"), "Recap").await.unwrap();
        assert!(MeetingChatRepository::has_recap(&pool, "m1").await.unwrap());
        MeetingChatRepository::append_recap_once(&pool, "m1", Some("Terms again"), "Recap again").await.unwrap();
        let chat = MeetingChatRepository::get_for_meeting(&pool, "m1").await.unwrap();
        let roles: Vec<(ChatRole, &str)> = chat.iter().map(|m| (m.role, m.text.as_str())).collect();
        assert_eq!(roles, vec![(ChatRole::User, "Who owns it?"), (ChatRole::KeyTerms, "Terms"), (ChatRole::Recap, "Recap")]);
    }

    #[tokio::test]
    async fn key_terms_can_be_rewritten_once_they_exist() {
        let pool = pool().await;
        assert!(!MeetingChatRepository::set_key_terms(&pool, "m1", "Edited").await.unwrap());
        MeetingChatRepository::append_recap_once(&pool, "m1", Some("Terms"), "Recap").await.unwrap();
        assert!(MeetingChatRepository::set_key_terms(&pool, "m1", "Rollout with Anya").await.unwrap());
        let chat = MeetingChatRepository::get_for_meeting(&pool, "m1").await.unwrap();
        let roles: Vec<(ChatRole, &str)> = chat.iter().map(|m| (m.role, m.text.as_str())).collect();
        assert_eq!(roles, vec![(ChatRole::KeyTerms, "Rollout with Anya"), (ChatRole::Recap, "Recap")]);
    }

    #[tokio::test]
    async fn only_error_replies_can_be_dismissed() {
        let pool = pool().await;
        MeetingChatRepository::append(&pool, "m1", &[message(ChatRole::User, "Who owns it?", false), message(ChatRole::Assistant, "Provider returned 401", true)]).await.unwrap();
        MeetingChatRepository::delete_error(&pool, "m1", 1).await.unwrap();
        MeetingChatRepository::delete_error(&pool, "m1", 2).await.unwrap();
        let chat = MeetingChatRepository::get_for_meeting(&pool, "m1").await.unwrap();
        let texts: Vec<&str> = chat.iter().map(|m| m.text.as_str()).collect();
        assert_eq!(texts, vec!["Who owns it?"]);
    }

    #[tokio::test]
    async fn a_recap_without_key_terms_comes_alone() {
        let pool = pool().await;
        MeetingChatRepository::append_recap_once(&pool, "m1", None, "Recap").await.unwrap();
        let chat = MeetingChatRepository::get_for_meeting(&pool, "m1").await.unwrap();
        let roles: Vec<ChatRole> = chat.iter().map(|m| m.role).collect();
        assert_eq!(roles, vec![ChatRole::Recap]);
    }

    #[tokio::test]
    async fn replacing_the_chat_drops_the_old_messages() {
        let pool = pool().await;
        MeetingChatRepository::append(&pool, "m1", &[message(ChatRole::User, "old", false)]).await.unwrap();
        MeetingChatRepository::replace_for_meeting(&pool, "m1", &[message(ChatRole::User, "new", false)]).await.unwrap();
        let chat = MeetingChatRepository::get_for_meeting(&pool, "m1").await.unwrap();
        assert_eq!(chat.len(), 1);
        assert_eq!(chat[0].text, "new");
        assert!(MeetingChatRepository::get_for_meeting(&pool, "other").await.unwrap().is_empty());
    }
}
