mod aircraft;
mod error;
mod store;

use anyhow::Context;
use axum::{Router, extract::State, http::StatusCode, routing::get};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tracing_subscriber::EnvFilter;

const BIND_ADDR: &str = "127.0.0.1:3000";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL must be set")?;
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(&database_url)
        .await
        .context("connecting to the database")?;

    let app = Router::new()
        .route("/health", get(health))
        .route("/aircraft", get(aircraft::list))
        .with_state(pool);

    let listener = tokio::net::TcpListener::bind(BIND_ADDR)
        .await
        .with_context(|| format!("binding {BIND_ADDR}"))?;
    tracing::info!("listening on {BIND_ADDR}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await?;
    tracing::info!("shutting down");
    Ok(())
}

/// Returns 200 when the database is reachable.
async fn health(State(pool): State<PgPool>) -> StatusCode {
    match sqlx::query("SELECT 1").execute(&pool).await {
        Ok(_) => StatusCode::OK,
        Err(err) => {
            tracing::error!("health check: {err:#}");
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}
