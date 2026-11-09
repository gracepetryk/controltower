use aide::{
    OperationOutput,
    generate::GenContext,
    openapi::{Operation, Response as ApiResponse},
};
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
};

use crate::store::{AircraftInError, MAX_AREA_EDGE_METERS};

pub enum ApiError {
    /// The request was invalid. The message is returned to the client.
    BadRequest(String),
    /// The requested area is larger than the server searches. The message is
    /// returned to the client.
    AreaTooLarge(String),
    /// Something failed on our side. It is logged, and the client gets a
    /// generic message.
    Internal(anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message).into_response(),
            Self::AreaTooLarge(message) => (StatusCode::PAYLOAD_TOO_LARGE, message).into_response(),
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

impl From<AircraftInError> for ApiError {
    fn from(err: AircraftInError) -> Self {
        match err {
            AircraftInError::AreaTooLarge {
                longest_edge_meters,
            } => Self::AreaTooLarge(format!(
                "bbox has an edge {:.0} km long; the most is {:.0} km",
                longest_edge_meters / 1000.0,
                MAX_AREA_EDGE_METERS / 1000.0,
            )),
            AircraftInError::Database(err) => err.into(),
        }
    }
}

/// Documents every variant as a plain-text response.
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
                Some(413),
                ApiResponse {
                    description: "The requested area is too large. The body says why.".into(),
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
