//! The others in a session, as every Playground app draws them: a pointer with a name tag in the person's color, their
//! playhead with a flag, a ghost of what they are dragging and an outline around what they have selected; their marks
//! eased toward where they last were, so a few updates a second still glide.
//!
//! The app keeps the others with [`show`] (from [`crate::Live::live_show_presence`]), reads them with [`others`] where
//! a view draws, maps each person's presence to the view's points, eases the moving marks with [`ease`] and draws them
//! with [`cursor`] (or [`cursor_with`] a value), [`playhead`], [`ghost`] and [`outline`] (or [`ghost_shape`] and
//! [`outline_shape`] for shapes that aren't upright boxes), [`dashed`] for what is being dragged out, and values being
//! set with [`label`]. Marks of any length ease with [`ease_list`], angles with [`ease_angle`]. [`end_frame`], after
//! the app drew, keeps a mark easing (repaints) and tells [`quiet`] whether a gesture is under way. Everything another
//! person sends is data: an app reads it defensively and [`ease`] drops what isn't a finite number.

use crate::Presence;
use egui::emath::GuiRounding as _;
use egui::{Color32, Context, CornerRadius, Painter, Pos2, Rect, Shape, Stroke, StrokeKind, Vec2, pos2, vec2};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::sync::Arc;

/// How long a mark takes to go most (1 - 1/e) of the way to its latest place, in seconds.
pub const EASE: f64 = 0.08;
/// The most characters of a name tag.
pub const MAX_NAME: usize = 24;
/// The space around a name tag's text.
const PAD: Vec2 = vec2(7.0, 3.0);

struct Mark {
    at: Vec<f64>,
    drawn: bool,
}

thread_local! {
    static OTHERS: RefCell<Vec<Presence>> = const { RefCell::new(Vec::new()) };
    /// Each person's marks as last drawn, by (person, mark).
    static MARKS: RefCell<HashMap<(String, String), Mark>> = RefCell::default();
    static MOVING: Cell<bool> = const { Cell::new(false) };
    static BUSY: Cell<bool> = const { Cell::new(false) };
    static FONT: RefCell<Option<egui::FontId>> = const { RefCell::new(None) };
}

/// The font of name tags, 12 px of the app's own (often its semibold); the default is egui's proportional 12 px.
pub fn set_font(font: egui::FontId) {
    FONT.with_borrow_mut(|f| *f = Some(font));
}

/// Keeps the others' presence for the views to draw (all of them, each time it changes; empty when the session ends).
pub fn show(others: Vec<Presence>) {
    OTHERS.with_borrow_mut(|o| *o = others);
}

/// The others, as last shown.
pub fn others() -> Vec<Presence> {
    OTHERS.with_borrow(Clone::clone)
}

/// A person's color.
pub fn color(p: &Presence) -> Color32 {
    Color32::from_rgb(p.color[0], p.color[1], p.color[2])
}

/// The end of a frame, after the app drew: whether a pointer button is held or a text field focused (for [`quiet`]),
/// marks no view drew this frame forgotten, and another frame asked for while one is still on its way.
pub fn end_frame(ctx: &Context) {
    BUSY.set(ctx.input(|i| i.pointer.any_down()) || ctx.text_edit_focused());
    MARKS.with_borrow_mut(|marks| {
        marks.retain(|_, m| std::mem::take(&mut m.drawn));
    });
    if MOVING.take() {
        ctx.request_repaint();
    }
}

/// No pointer button held and no text field focused at the end of the last frame: nothing a remote change would cut
/// short (the usual [`crate::Live::live_quiet`], with whatever else the app has under way).
pub fn quiet() -> bool {
    !BUSY.get()
}

/// Asks for another frame at [`end_frame`], for a mark that moves on its own (a stroke being revealed, a fading tag).
pub fn keep_moving() {
    MOVING.set(true);
}

/// Person `who`'s mark `key` eased toward `target` (in the document's units, so this person's scrolling never lags):
/// [`EASE`] of the way per frame time; `px` is points per unit on each axis, and a jump wider than `far` points on any
/// axis, or a mark first seen, goes at once. None when `target` isn't all finite numbers.
pub fn ease<const N: usize>(ctx: &Context, who: &str, key: &str, target: [f64; N], px: [f64; N], far: [f64; N]) -> Option<[f64; N]> {
    let eased = ease_list(ctx, who, key, &target, &px, &far)?;
    let mut out = [0.0; N];
    out.copy_from_slice(&eased);
    Some(out)
}

/// [`ease`] for a mark of any length: a list of points, a shape's corners, a line's vertices. `px` and `far` repeat
/// along `target` (`[x, y]` for a list of points); a list of another length than last time goes at once.
pub fn ease_list(ctx: &Context, who: &str, key: &str, target: &[f64], px: &[f64], far: &[f64]) -> Option<Vec<f64>> {
    if target.iter().any(|v| !v.is_finite()) || px.is_empty() || far.is_empty() {
        return None;
    }
    let dt = f64::from(ctx.input(|i| i.stable_dt).clamp(0.0, 0.1));
    let k = 1.0 - (-dt / EASE).exp();
    MARKS.with_borrow_mut(|marks| {
        let mark = marks.entry((who.to_owned(), key.to_owned())).or_insert_with(|| Mark { at: target.to_vec(), drawn: true });
        mark.drawn = true;
        let off = |at: &[f64], i: usize| ((target[i] - at[i]) * px[i % px.len()]).abs();
        let n = target.len();
        if mark.at.len() != n || (0..n).any(|i| !(off(&mark.at, i) <= far[i % far.len()])) {
            mark.at = target.to_vec();
        }
        for i in 0..n {
            mark.at[i] += (target[i] - mark.at[i]) * k;
        }
        if (0..n).any(|i| off(&mark.at, i) >= 0.5) {
            MOVING.set(true);
        } else {
            mark.at = target.to_vec();
        }
        Some(mark.at.clone())
    })
}

/// [`ease`] for an angle in degrees, turning the short way round across 0/360; `px` points per degree (at the mark's
/// reach), `far` as in [`ease`]. The result may lie outside 0..360.
pub fn ease_angle(ctx: &Context, who: &str, key: &str, degrees: f64, px: f64, far: f64) -> Option<f64> {
    if !degrees.is_finite() {
        return None;
    }
    let at = MARKS.with_borrow(|marks| marks.get(&(who.to_owned(), key.to_owned())).and_then(|m| m.at.first().copied()));
    let target = at.map_or(degrees, |at| at + (degrees - at + 180.0).rem_euclid(360.0) - 180.0);
    ease(ctx, who, key, [target], [px], [far]).map(|[d]| d)
}

/// A pointer at `tip` with a name tag, in `color`.
pub fn cursor(painter: &Painter, tip: Pos2, color: Color32, name: &str) {
    const ARROW: [[f32; 2]; 7] = [[0.0, 0.0], [0.0, 16.0], [4.5, 12.2], [7.6, 18.6], [10.4, 17.3], [7.3, 11.0], [12.5, 11.0]];
    // Star-shaped around the tip (its first point), which is what a filled path's triangle fan needs.
    let arrow = |d: Vec2| ARROW.iter().map(|&[x, y]| tip + d + vec2(x, y)).collect::<Vec<_>>();
    let shadow = Color32::from_black_alpha(64);
    painter.add(Shape::convex_polygon(arrow(vec2(0.0, 1.0)), shadow, Stroke::new(1.5, shadow)));
    painter.add(Shape::convex_polygon(arrow(Vec2::ZERO), color, Stroke::new(1.5, Color32::WHITE)));
    tag(painter, tip + vec2(12.0, 15.0), color, name);
}

/// A name tag with its top left at `at`; where it went (nothing for an empty name).
pub fn tag(painter: &Painter, at: Pos2, color: Color32, name: &str) -> Rect {
    if name.is_empty() {
        return Rect::from_min_size(at, Vec2::ZERO);
    }
    let text = tag_text(painter, name, color);
    let rect = Rect::from_min_size(at.round_to_pixels(painter.pixels_per_point()), text.size() + 2.0 * PAD);
    painter.rect_filled(rect, 6.0, color);
    painter.galley(rect.min + PAD, text, color);
    rect
}

/// A pointer at `tip` with a name tag and, under it, a [`label`] of the `value` the person is setting ("-6.0 dB",
/// "Exposure 0.00"; none when empty); where the tags went.
pub fn cursor_with(painter: &Painter, tip: Pos2, color: Color32, name: &str, value: &str) -> Rect {
    cursor(painter, tip, color, "");
    let name_at = tip + vec2(12.0, 15.0);
    let tag = tag(painter, name_at, color, name);
    let under = if name.is_empty() { name_at } else { pos2(tag.min.x, tag.max.y + 2.0) };
    tag.union(label(painter, under, color, value))
}

/// The size [`tag`] would take for `name` (cut as it cuts it), to place it before drawing.
pub fn tag_size(painter: &Painter, name: &str) -> Vec2 {
    if name.is_empty() {
        return Vec2::ZERO;
    }
    tag_text(painter, name, Color32::WHITE).size() + 2.0 * PAD
}

/// A tag in the same look holding any short text, uncut (a value being set: "Exposure 0.00", "-6.0 dB", "3 photos"), with
/// its top left at `at`; where it went. Text past 64 characters is cut.
pub fn label(painter: &Painter, at: Pos2, color: Color32, text: &str) -> Rect {
    if text.is_empty() {
        return Rect::from_min_size(at, Vec2::ZERO);
    }
    let galley = text_galley(painter, &cut(text, 64), color);
    let rect = Rect::from_min_size(at.round_to_pixels(painter.pixels_per_point()), galley.size() + 2.0 * PAD);
    painter.rect_filled(rect, 6.0, color);
    painter.galley(rect.min + PAD, galley, color);
    rect
}

/// The size [`label`] would take for `text`, to place it before drawing (beside a slider, above a box).
pub fn label_size(painter: &Painter, text: &str) -> Vec2 {
    if text.is_empty() {
        return Vec2::ZERO;
    }
    text_galley(painter, &cut(text, 64), Color32::WHITE).size() + 2.0 * PAD
}

/// `text` cut to `max` characters, ending in an ellipsis when cut.
fn cut(text: &str, max: usize) -> String {
    match text.chars().count() > max {
        true => text.chars().take(max - 1).chain(['…']).collect(),
        false => text.to_owned(),
    }
}

/// A name tag's text: the name cut to [`MAX_NAME`] characters, in [`set_font`]'s font, white or (on a light `color`)
/// near-black.
fn tag_text(painter: &Painter, name: &str, color: Color32) -> Arc<egui::Galley> {
    text_galley(painter, &cut(name, MAX_NAME), color)
}

/// `text` in [`set_font`]'s font, white or (on a light `color`) near-black.
fn text_galley(painter: &Painter, text: &str, color: Color32) -> Arc<egui::Galley> {
    let l = egui::Rgba::from(color);
    let ink = match 0.2126 * l.r() + 0.7152 * l.g() + 0.0722 * l.b() > 0.55 {
        true => Color32::from_gray(0x11),
        false => Color32::WHITE,
    };
    let font = FONT.with_borrow(|f| f.clone()).unwrap_or_else(|| egui::FontId::proportional(12.0));
    painter.layout_no_wrap(text.to_owned(), font, ink)
}

/// Another person's playhead at `x`, from `top` to `bottom`: a line 1.5 px wide in 85% of their color, and at its top a
/// flag with their name, hanging right of the line, or left of it where it would pass `right`.
pub fn playhead(painter: &Painter, x: f32, [top, bottom]: [f32; 2], right: f32, color: Color32, name: &str) {
    let x = painter.round_to_pixel_center(x);
    painter.line_segment([pos2(x, top), pos2(x, bottom)], Stroke::new(1.5, color.gamma_multiply(0.85)));
    if name.is_empty() {
        return;
    }
    let text = tag_text(painter, name, color);
    let (rect, left) = flag(x, top, text.size() + 2.0 * PAD, right);
    let rect = rect.round_to_pixels(painter.pixels_per_point());
    // Square where it meets the line.
    let corners = match left {
        true => CornerRadius { ne: 0, ..CornerRadius::same(6) },
        false => CornerRadius { nw: 0, ..CornerRadius::same(6) },
    };
    painter.rect_filled(rect, corners, color);
    painter.galley(rect.min + PAD, text, color);
}

/// Where a playhead's flag of `size` goes on its line at `x` from `top`, and whether left of the line.
fn flag(x: f32, top: f32, size: Vec2, right: f32) -> (Rect, bool) {
    let left = x + size.x > right;
    let x = if left { x + 0.75 - size.x } else { x - 0.75 };
    (Rect::from_min_size(pos2(x, top), size), left)
}

/// What another person is dragging, where it would land: their color at 28% with an edge.
pub fn ghost(painter: &Painter, rect: Rect, color: Color32) {
    painter.rect(rect, 2.0, color.gamma_multiply(0.28), Stroke::new(1.5, color.gamma_multiply(0.85)), StrokeKind::Inside);
}

/// What another person has selected: a 2 px outline in their color.
pub fn outline(painter: &Painter, rect: Rect, color: Color32) {
    painter.rect_stroke(rect, 2.0, Stroke::new(2.0, color), StrokeKind::Inside);
}

/// [`ghost`] for a shape that isn't an upright box: a convex outline in order (a rotated or skewed box, a frame's
/// corners). A concave shape's fill is the app's to draw; its edge can still be [`outline_shape`].
pub fn ghost_shape(painter: &Painter, points: &[Pos2], color: Color32) {
    if points.len() < 3 {
        return;
    }
    painter.add(Shape::convex_polygon(points.to_vec(), color.gamma_multiply(0.28), Stroke::NONE));
    painter.add(Shape::closed_line(points.to_vec(), Stroke::new(1.5, color.gamma_multiply(0.85))));
}

/// [`outline`] for a shape that isn't an upright box: a 2 px closed line through `points`, in order.
pub fn outline_shape(painter: &Painter, points: &[Pos2], color: Color32) {
    if points.len() >= 2 {
        painter.add(Shape::closed_line(points.to_vec(), Stroke::new(2.0, color)));
    }
}

/// What another person is dragging out (a rubber band, a box or line being drawn, a text box): a 1.5 px dashed line
/// through `points` in their color, 4 points on and 3 off, closed back to the first point when `closed`.
pub fn dashed(painter: &Painter, points: &[Pos2], closed: bool, color: Color32) {
    let mut path = points.to_vec();
    if closed && points.len() > 2 {
        path.push(points[0]);
    }
    if path.len() >= 2 {
        painter.extend(Shape::dashed_line(&path, Stroke::new(1.5, color), 4.0, 3.0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_glide_jump_when_far_and_are_forgotten_when_not_drawn() {
        let ctx = Context::default();
        let first = ease(&ctx, "a", "pointer", [10.0, 1.0], [1.0, 1.0], [100.0, 100.0]);
        assert_eq!(first, Some([10.0, 1.0]), "a new mark goes at once");
        let step = ease(&ctx, "a", "pointer", [20.0, 1.0], [1.0, 1.0], [100.0, 100.0]).unwrap();
        assert!(step[0] > 10.0 && step[0] < 20.0, "{step:?}");
        assert_eq!(ease(&ctx, "a", "pointer", [500.0, 1.0], [1.0, 1.0], [100.0, 100.0]), Some([500.0, 1.0]), "far: at once");
        assert_eq!(ease(&ctx, "a", "pointer", [f64::NAN, 1.0], [1.0, 1.0], [100.0, 100.0]), None);
        end_frame(&ctx);
        end_frame(&ctx);
        assert_eq!(ease(&ctx, "a", "pointer", [20.0, 1.0], [1.0, 1.0], [100.0, 100.0]), Some([20.0, 1.0]), "forgotten, so new again");
    }

    #[test]
    fn lists_and_angles_ease_like_marks() {
        let ctx = Context::default();
        assert_eq!(ease_list(&ctx, "b", "line", &[0.0, 0.0, 10.0, 10.0], &[1.0], &[100.0]), Some(vec![0.0, 0.0, 10.0, 10.0]));
        let step = ease_list(&ctx, "b", "line", &[20.0, 0.0, 30.0, 10.0], &[1.0, 1.0], &[100.0]).unwrap();
        assert!(step[0] > 0.0 && step[0] < 20.0 && step[1] == 0.0, "{step:?}");
        assert_eq!(ease_list(&ctx, "b", "line", &[1.0, 2.0], &[1.0], &[100.0]), Some(vec![1.0, 2.0]), "another length: at once");
        assert_eq!(ease_angle(&ctx, "b", "turn", 350.0, 1.0, 1000.0), Some(350.0));
        let turned = ease_angle(&ctx, "b", "turn", 10.0, 1.0, 1000.0).unwrap();
        assert!(turned > 350.0 && turned < 370.0, "the short way, through 360: {turned}");
    }

    #[test]
    fn labels_keep_values_whole_and_names_are_cut() {
        assert_eq!(cut("Exposure 0.00", 64), "Exposure 0.00");
        assert_eq!(cut("abcdef", 4), "abc…");
        let long = "a".repeat(30);
        assert_eq!(cut(&long, MAX_NAME).chars().count(), MAX_NAME);
    }

    #[test]
    fn a_flag_hangs_from_its_line_and_stays_in_view() {
        let size = vec2(60.0, 21.0);
        assert_eq!(flag(100.5, 31.0, size, 1100.0), (Rect::from_min_size(pos2(99.75, 31.0), size), false));
        assert_eq!(flag(1080.5, 31.0, size, 1100.0), (Rect::from_min_size(pos2(1021.25, 31.0), size), true));
    }
}
