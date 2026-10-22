use sqlx::{Row, SqlitePool};

use crate::assistant::{Suggestion, SuggestionKind};

pub struct MeetingSuggestionsRepository;

impl MeetingSuggestionsRepository {
    pub async fn replace_for_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
        items: &[Suggestion],
    ) -> Result<(), sqlx::Error> {
        let mut transaction = pool.begin().await?;
        sqlx::query("DELETE FROM meeting_suggestions WHERE meeting_id = ?")
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;
        let created_at = chrono::Utc::now().to_rfc3339();
        for item in items {
            sqlx::query(
                "INSERT INTO meeting_suggestions (id, meeting_id, kind, text, why, at_seconds, sequence_id, pinned, dismissed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&item.id)
            .bind(meeting_id)
            .bind(item.kind.as_str())
            .bind(&item.text)
            .bind(&item.why)
            .bind(item.at_seconds)
            .bind(item.sequence_id as i64)
            .bind(item.pinned as i64)
            .bind(item.dismissed as i64)
            .bind(&created_at)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await
    }

    pub async fn dismiss(pool: &SqlitePool, meeting_id: &str, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE meeting_suggestions SET dismissed = 1 WHERE meeting_id = ? AND id = ?")
            .bind(meeting_id)
            .bind(id)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn get_for_meeting(
        pool: &SqlitePool,
        meeting_id: &str,
    ) -> Result<Vec<Suggestion>, sqlx::Error> {
        let rows = sqlx::query(
            "SELECT id, kind, text, why, at_seconds, sequence_id, pinned, dismissed FROM meeting_suggestions WHERE meeting_id = ? ORDER BY sequence_id, id",
        )
        .bind(meeting_id)
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .filter_map(|row| {
                let kind = SuggestionKind::parse(row.get::<String, _>("kind").as_str())?;
                Some(Suggestion {
                    id: row.get("id"),
                    kind,
                    text: row.get("text"),
                    why: row.get("why"),
                    at_seconds: row.get("at_seconds"),
                    sequence_id: row.get::<i64, _>("sequence_id").max(0) as u64,
                    pinned: row.get::<i64, _>("pinned") != 0,
                    dismissed: row.get::<i64, _>("dismissed") != 0,
                    missed_ticks: 0,
                    after_chat: None,
                })
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

    fn suggestion(id: &str, kind: SuggestionKind) -> Suggestion {
        Suggestion {
            id: id.to_string(),
            kind,
            text: format!("text {}", id),
            why: String::new(),
            at_seconds: 12.0,
            sequence_id: 1,
            pinned: false,
            dismissed: false,
            missed_ticks: 0,
            after_chat: None,
        }
    }

    #[tokio::test]
    async fn call_suggestions_stay_until_each_one_is_dismissed() {
        let pool = pool().await;
        let items = [suggestion("s1", SuggestionKind::Question), suggestion("s2", SuggestionKind::Tip)];
        MeetingSuggestionsRepository::replace_for_meeting(&pool, "m1", &items).await.unwrap();

        MeetingSuggestionsRepository::dismiss(&pool, "m1", "s1").await.unwrap();

        let stored = MeetingSuggestionsRepository::get_for_meeting(&pool, "m1").await.unwrap();
        let dismissed: Vec<(&str, bool)> = stored.iter().map(|item| (item.id.as_str(), item.dismissed)).collect();
        assert_eq!(dismissed, vec![("s1", true), ("s2", false)]);
    }
}
