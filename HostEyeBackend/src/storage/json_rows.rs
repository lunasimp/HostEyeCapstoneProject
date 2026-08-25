use serde::Serialize;

pub async fn insert_json<T: Serialize>(table: &str, row: &T) -> anyhow::Result<()> {
    let clickhouse_url = std::env::var("CLICKHOUSE_URL")
        .unwrap_or_else(|_| "http://clickhouse:8123".to_string());
    let query = format!("INSERT INTO {} FORMAT JSONEachRow", table);
    let mut body = serde_json::to_string(row)?;
    body.push('\n');

    let response = reqwest::Client::new()
        .post(clickhouse_url.trim_end_matches('/'))
        .query(&[
            ("query", query.as_str()),
            ("date_time_input_format", "best_effort"),
            ("input_format_skip_unknown_fields", "1"),
        ])
        .header("content-type", "application/x-ndjson")
        .body(body)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let message = response.text().await.unwrap_or_default();
        anyhow::bail!("ClickHouse {} {}: {}", table, status, message);
    }
    Ok(())
}
