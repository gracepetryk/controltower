mod aircraft;
mod clock;
mod error;
mod store;

use std::{sync::Arc, time::Duration};

use aide::{
    axum::{ApiRouter, IntoApiResponse, routing::get_with},
    openapi::{Info, OpenApi},
    scalar::Scalar,
    transform::TransformOperation,
};
use anyhow::Context;
use axum::{
    Extension, Json,
    extract::{FromRef, State},
    http::StatusCode,
    routing::get,
};
use sqlx::{PgPool, postgres::PgPoolOptions};
use tracing_subscriber::EnvFilter;

use crate::clock::Clock;

const DEFAULT_BIND_ADDR: &str = "127.0.0.1:3000";

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    clock: Clock,
}

impl FromRef<AppState> for PgPool {
    fn from_ref(state: &AppState) -> Self {
        state.pool.clone()
    }
}

impl FromRef<AppState> for Clock {
    fn from_ref(state: &AppState) -> Self {
        state.clock
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let clock = Clock::from_env()?;
    if let Clock::Replay(date) = clock {
        tracing::info!(%date, "replaying recorded positions");
    }
    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL must be set")?;
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_millis(1000))
        .connect_lazy(&database_url)
        .context("Unable to create Postgres connection pool")?;

    let mut api = OpenApi {
        info: Info {
            title: "controltower".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            ..Info::default()
        },
        ..OpenApi::default()
    };
    let app = ApiRouter::new()
        .api_route("/health", get_with(health, health_docs))
        .api_route("/aircraft", get_with(aircraft::list, aircraft::list_docs))
        .route("/openapi.json", get(openapi_json))
        .route(
            "/docs",
            Scalar::new("/openapi.json")
                .with_title("controltower API")
                .axum_route(),
        )
        .finish_api(&mut api)
        .layer(Extension(Arc::new(api)))
        .with_state(AppState { pool, clock });

    let bind_addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| DEFAULT_BIND_ADDR.into());
    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .with_context(|| format!("binding {bind_addr}"))?;
    tracing::info!("listening on {bind_addr}");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            tokio::signal::ctrl_c().await.ok();
        })
        .await?;
    tracing::info!("shutting down");
    Ok(())
}

async fn health(State(pool): State<PgPool>) -> StatusCode {
    match sqlx::query("SELECT 1").execute(&pool).await {
        Ok(_) => StatusCode::OK,
        Err(err) => {
            tracing::error!("health check: {err:#}");
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}

fn health_docs(op: TransformOperation) -> TransformOperation {
    op.summary("Health check")
        .description("Returns 200 when the database is reachable and 503 when it isn't.")
}

async fn openapi_json(Extension(api): Extension<Arc<OpenApi>>) -> impl IntoApiResponse {
    Json(api)
}
