use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};

pub enum ApiError {
    /// The request was invalid. The message is returned to the client.
    BadRequest(String),
    /// Something failed on our side. It is logged, and the client gets a
    /// generic message.
    Internal(anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message).into_response(),
            Self::Internal(err) => {
                tracing::error!("{err:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response()
            }
        }
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        Self::Internal(err.into())
    }
}
