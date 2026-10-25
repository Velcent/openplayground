//! Playground live editing for an app, as one crate: the session (src/session.rs: the shared document, its three-way
//! merge, Undo going to the session, media and presence passed to and from `shell/live.js`) and, with the `egui`
//! feature, [`presence`]: how the others are drawn, the same in every app.
//!
//! An app's own part is its hooks: [`Live`] on its model (what the shared document is, how a merged one goes back in,
//! where its media are, what its presence says), [`frame`] at the end of each frame, [`undo`] first in its Undo and
//! Redo, [`web::attach`] once it runs, and calls into [`presence`] where its views draw the others.

mod session;
pub use session::*;

#[cfg(feature = "egui")]
pub mod presence;
