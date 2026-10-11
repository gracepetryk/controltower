use aide::{
    OperationOutput,
    generate::GenContext,
    openapi::{Operation, Response as ApiResponse},
};
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

/// Documents both variants as plain-text responses.
impl OperationOutput for ApiError {
    type Inner = String;

    fn operation_response(ctx: &mut GenContext, operation: &mut Operation) -> Option<ApiResponse> {
        String::operation_response(ctx, operation)
    }

    fn inferred_responses(
        ctx: &mut GenContext,
        operation: &mut Operation,
    ) -> Vec<(Option<u16>, ApiResponse)> {
        let Some(response) = Self::operation_response(ctx, operation) else {
            return Vec::new();
        };
        Vec::from([
            (
                Some(400),
                ApiResponse {
                    description: "The request is invalid. The body says why.".into(),
                    ..response.clone()
                },
            ),
            (
                Some(500),
                ApiResponse {
                    description: "Internal error.".into(),
                    ..response
                },
            ),
        ])
    }
}
