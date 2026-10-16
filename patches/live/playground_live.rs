//! Playground live editing, an optional web-only adapter (Playground's `shell/live.js` drives it). The shared document
//! is the app's own model as JSON, without personal views. A remote change merges into the live document at the end
//! of a quiet frame, keeping this person's views and unsent work, and is no step of the native undo history. While
//! connected, Undo and Redo go to the session, which reverts only this person's operations. Nothing here runs until
//! the shell connects.
//!
//! An app implements [`Live`], calls [`frame`] at the end of each frame and [`undo`] at the top of its Undo and Redo,
//! and on the web calls [`web::attach`] once it runs.

use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};

/// What an app supplies for live editing.
pub trait Live {
    /// The shared document. Personal views (zoom, scroll, selection, tools, panels) stay out.
    fn live_document(&self) -> Value;
    /// Installs `document` as the shared state, keeping this person's views, with no step in the native undo history.
    fn live_adopt(&mut self, document: Value) -> Result<(), String>;
    /// Nothing under way that a remote change would cut short or a proposal would catch half done: no pointer down,
    /// drag, stroke or text being typed.
    fn live_quiet(&self) -> bool;
    /// Changes whenever the shared document may have: a frame with the same value skips serializing it. `None`: always
    /// compare.
    fn live_generation(&self) -> Option<u64> {
        None
    }
    /// The session ended: native Undo starts again from the current document.
    fn live_disconnected(&mut self) {}
    /// Object keys whose numbers are allocators: merged by maximum, so concurrent additions do not conflict on them.
    const COUNTERS: &'static [&'static str] = &[];
    /// The three-way merge of shared documents: [`merge`] with [`Self::COUNTERS`] unless the model needs its own (text).
    fn live_merge(base: &Value, current: &Value, edited: &Value) -> Result<Value, Error>
    where
        Self: Sized,
    {
        merge(base, current, edited, Self::COUNTERS)
    }
}

/// A conflict or an invalid document.
pub type Error = String;

/// Canonical bytes: object keys sorted at every level, so equal documents give equal bytes on every peer.
pub fn canonical(value: &Value) -> Vec<u8> {
    fn write(value: &Value, out: &mut Vec<u8>) {
        match value {
            Value::Object(map) => {
                out.push(b'{');
                let sorted: BTreeMap<_, _> = map.iter().collect();
                for (i, (key, value)) in sorted.into_iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    out.extend(serde_json::to_vec(key).unwrap_or_default());
                    out.push(b':');
                    write(value, out);
                }
                out.push(b'}');
            }
            Value::Array(items) => {
                out.push(b'[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(b',');
                    }
                    write(item, out);
                }
                out.push(b']');
            }
            scalar => out.extend(serde_json::to_vec(scalar).unwrap_or_default()),
        }
    }
    let mut out = Vec::new();
    write(value, &mut out);
    out
}

pub fn parse(bytes: &[u8]) -> Result<Value, Error> {
    serde_json::from_slice(bytes).map_err(|e| format!("Invalid shared document: {e}"))
}

/// A strict three-way merge: each side's changes apply where the other left the value as it was; a value both sides
/// changed is a conflict, even to the same thing (equal values do not prove who made them; the session's operation IDs
/// deduplicate). Objects merge by key. Arrays whose items are all objects with a unique scalar `id` merge by id, with
/// additions kept next to their neighbors; other arrays are single values. `counters` keys take the maximum.
pub fn merge(
    base: &Value,
    current: &Value,
    edited: &Value,
    counters: &[&str],
) -> Result<Value, Error> {
    merge_at(Some(base), Some(current), Some(edited), counters, "")?
        .ok_or_else(|| "Conflict: document removed".into())
}

pub fn merge_bytes(
    base: &[u8],
    current: &[u8],
    edited: &[u8],
    counters: &[&str],
) -> Result<Vec<u8>, Error> {
    Ok(canonical(&merge(
        &parse(base)?,
        &parse(current)?,
        &parse(edited)?,
        counters,
    )?))
}

fn conflict(path: &str) -> Error {
    format!("Conflict at {}", if path.is_empty() { "/" } else { path })
}

fn merge_at(
    b: Option<&Value>,
    c: Option<&Value>,
    e: Option<&Value>,
    counters: &[&str],
    path: &str,
) -> Result<Option<Value>, Error> {
    if e == b {
        return Ok(c.cloned());
    }
    if c == b {
        return Ok(e.cloned());
    }
    let key = path.rsplit('/').next().unwrap_or_default();
    match (b, c, e) {
        (Some(Value::Object(b)), Some(Value::Object(c)), Some(Value::Object(e))) => {
            let mut out = serde_json::Map::new();
            let keys: std::collections::BTreeSet<_> =
                b.keys().chain(c.keys()).chain(e.keys()).collect();
            for k in keys {
                if let Some(v) = merge_at(
                    b.get(k),
                    c.get(k),
                    e.get(k),
                    counters,
                    &format!("{path}/{k}"),
                )? {
                    out.insert(k.clone(), v);
                }
            }
            Ok(Some(Value::Object(out)))
        }
        (Some(Value::Array(b)), Some(Value::Array(c)), Some(Value::Array(e)))
            if keyed(&[b, c, e]) =>
        {
            keyed_merge(b, c, e, counters, path).map(|v| Some(Value::Array(v)))
        }
        (Some(Value::Number(_)), Some(Value::Number(_)), Some(Value::Number(_)))
            if counters.contains(&key) =>
        {
            let n = |v: Option<&Value>| v.and_then(Value::as_f64).unwrap_or(f64::MIN);
            Ok(if n(c) >= n(e) { c.cloned() } else { e.cloned() })
        }
        _ => Err(conflict(path)),
    }
}

fn id(item: &Value) -> Option<String> {
    match item.get("id")? {
        Value::String(s) => Some(format!("s{s}")),
        Value::Number(n) => Some(format!("n{n}")),
        _ => None,
    }
}

fn keyed(arrays: &[&Vec<Value>]) -> bool {
    arrays.iter().all(|items| {
        let mut seen = std::collections::HashSet::new();
        items
            .iter()
            .all(|item| id(item).is_some_and(|id| seen.insert(id)))
    }) && arrays.iter().any(|items| !items.is_empty())
}

fn keyed_merge(
    b: &[Value],
    c: &[Value],
    e: &[Value],
    counters: &[&str],
    path: &str,
) -> Result<Vec<Value>, Error> {
    let index = |items: &[Value]| -> BTreeMap<String, Value> {
        items
            .iter()
            .map(|item| (id(item).unwrap_or_default(), item.clone()))
            .collect()
    };
    let order = |items: &[Value]| -> Vec<String> { items.iter().filter_map(id).collect() };
    let (bm, cm, em) = (index(b), index(c), index(e));
    let mut merged = BTreeMap::new();
    for key in bm.keys().chain(cm.keys()).chain(em.keys()) {
        if merged.contains_key(key) {
            continue;
        }
        let at = format!("{path}[{}]", &key[1..]);
        if let Some(value) = merge_at(bm.get(key), cm.get(key), em.get(key), counters, &at)? {
            merged.insert(key.clone(), value);
        }
    }
    // The survivors every side has keep the order the one side that reordered them gave.
    let common = |items: &[Value]| -> Vec<String> {
        order(items)
            .into_iter()
            .filter(|k| {
                merged.contains_key(k)
                    && bm.contains_key(k)
                    && cm.contains_key(k)
                    && em.contains_key(k)
            })
            .collect()
    };
    let (bo, co, eo) = (common(b), common(c), common(e));
    let mut out = if co == bo {
        eo
    } else if eo == bo {
        co
    } else {
        return Err(conflict(&format!("{path} order")));
    };
    // Each side's additions go right after the item before them on that side.
    for side in [c, e] {
        let mut after: Option<String> = None;
        for key in order(side) {
            if merged.contains_key(&key) && !out.contains(&key) {
                let at = after
                    .as_ref()
                    .and_then(|a| out.iter().position(|k| k == a))
                    .map_or(0, |i| i + 1);
                out.insert(at, key.clone());
            }
            if out.contains(&key) {
                after = Some(key);
            }
        }
    }
    Ok(out.into_iter().filter_map(|k| merged.remove(&k)).collect())
}

/// A remote change waiting for a quiet frame: `edited` relative to `base`, or with no base the whole shared document.
struct Remote {
    base: Option<Vec<u8>>,
    edited: Vec<u8>,
    done: Done,
}

/// Settles a remote change: a whole adopted document gives back the one it replaced, for the shell's draft.
pub type Done = Box<dyn FnOnce(Result<Option<Vec<u8>>, Error>)>;

#[derive(Default)]
struct Session {
    connected: bool,
    /// The last frame was not quiet: a checkpoint now would catch a gesture half done.
    busy: bool,
    /// Ids handed out while connected.
    ids: u64,
    /// The generation and the canonical document last reported.
    generation: Option<u64>,
    reported: Option<Vec<u8>>,
    remote: VecDeque<Remote>,
    changes: u64,
    undos: Vec<bool>,
    repaint: Option<Box<dyn Fn()>>,
    #[cfg(target_arch = "wasm32")]
    hooks: Option<web::Hooks>,
}

thread_local! {
    static SESSION: std::cell::RefCell<Session> = std::cell::RefCell::default();
}

pub fn connect() {
    SESSION.with_borrow_mut(|s| {
        (s.connected, s.generation, s.reported) = (true, None, None);
        if let Some(repaint) = &s.repaint {
            repaint();
        }
    });
}

/// Ends the session's hold on Undo; changes still waiting fail.
pub fn disconnect() {
    let waiting = SESSION.with_borrow_mut(|s| {
        s.connected = false;
        #[cfg(target_arch = "wasm32")]
        {
            s.hooks = None;
        }
        std::mem::take(&mut s.remote)
    });
    for remote in waiting {
        (remote.done)(Err("Live editing disconnected".into()));
    }
}

pub fn queue(base: Option<Vec<u8>>, edited: Vec<u8>, done: Done) {
    let done = SESSION.with_borrow_mut(|s| {
        if !s.connected {
            return Some(done);
        }
        s.remote.push_back(Remote { base, edited, done });
        if let Some(repaint) = &s.repaint {
            repaint();
        }
        None
    });
    if let Some(done) = done {
        done(Err("Live editing is not connected".into()));
    }
}

/// The canonical shared document, unless the last frame was busy: then the next quiet frame reports it again.
pub fn checkpoint<A: Live>(app: &A) -> Result<Vec<u8>, Error> {
    let busy = SESSION.with_borrow_mut(|s| {
        if s.busy {
            (s.generation, s.reported) = (None, None);
        }
        s.busy
    });
    if busy {
        return Err("busy".into());
    }
    Ok(canonical(&app.live_document()))
}

/// A new object id from the app's counter `next`, which goes up as before. While connected the id is instead 2^52 plus
/// 52 random bits, so two people adding objects at once practically never pick the same one (and it stays below 2^53,
/// exact in JSON and the shell). For apps whose ids are opaque numbers; ids that index arrays or show to people need
/// the app's own scheme.
pub fn fresh_id(next: &mut u64) -> u64 {
    let id = *next;
    *next += 1;
    let connected = SESSION.with_borrow_mut(|s| {
        s.ids += 1;
        s.connected
    });
    if !connected {
        return id;
    }
    #[cfg(target_arch = "wasm32")]
    let random = {
        let half = || (js_sys::Math::random() * (1u64 << 26) as f64) as u64;
        (half() << 26) | half()
    };
    #[cfg(not(target_arch = "wasm32"))]
    let random = SESSION
        .with_borrow(|s| s.ids)
        .wrapping_mul(0x9E37_79B9_7F4A_7C15)
        >> 12;
    (1 << 52) | (random & ((1 << 52) - 1))
}

/// Passes Undo or Redo to the session while connected: whether it did. Call it first in the app's Undo and Redo.
pub fn undo(redo: bool) -> bool {
    let connected = SESSION.with_borrow_mut(|s| {
        if s.connected {
            s.undos.push(redo);
        }
        s.connected
    });
    #[cfg(target_arch = "wasm32")]
    if connected {
        web::call(|hooks| &hooks.undo, &redo.into());
    }
    connected
}

/// Shared changes reported and Undo/Redo requests passed on so far, for tests.
pub fn activity() -> (u64, Vec<bool>) {
    SESSION.with_borrow(|s| (s.changes, s.undos.clone()))
}

/// The end of each frame: applies the remote changes waiting and reports a changed shared document, once quiet.
pub fn frame<A: Live>(app: &mut A) {
    let quiet = app.live_quiet();
    if !SESSION.with_borrow_mut(|s| {
        s.busy = !quiet;
        s.connected && quiet
    }) {
        return;
    }
    let waiting = SESSION.with_borrow_mut(|s| std::mem::take(&mut s.remote));
    for remote in waiting {
        let result = adopt(app, remote.base.as_deref(), &remote.edited);
        (remote.done)(result);
    }
    let generation = app.live_generation();
    if generation.is_some() && SESSION.with_borrow(|s| s.generation == generation) {
        return;
    }
    let document = canonical(&app.live_document());
    let changed = SESSION.with_borrow_mut(|s| {
        s.generation = generation;
        let changed = s.reported.as_ref() != Some(&document);
        if changed {
            s.reported = Some(document);
            s.changes += 1;
        }
        changed
    });
    #[cfg(target_arch = "wasm32")]
    if changed {
        web::call(|hooks| &hooks.changed, &wasm_bindgen::JsValue::NULL);
    }
    #[cfg(not(target_arch = "wasm32"))]
    let _ = changed;
}

fn adopt<A: Live>(
    app: &mut A,
    base: Option<&[u8]>,
    edited: &[u8],
) -> Result<Option<Vec<u8>>, Error> {
    let edited = parse(edited)?;
    let current = app.live_document();
    let (document, replaced) = match base {
        Some(base) => (A::live_merge(&parse(base)?, &current, &edited)?, None),
        None => (edited, Some(canonical(&current))),
    };
    app.live_adopt(document)?;
    Ok(replaced)
}

/// The adapter object the Playground shell drives (`shell/live.js`): `format`, `checkpoint()` (throws `busy` while a
/// gesture is under way), `merge(base, current, edited)`, `apply(base | null, edited)` (a promise, settled at the next
/// quiet frame; a whole adopted document resolves to the one it replaced), `connect({ changed, undo })` and
/// `disconnect()`. The hooks are called from inside a frame: the shell defers its calls back.
#[cfg(target_arch = "wasm32")]
pub mod web {
    use super::{Live, SESSION};
    use js_sys::{Function, Object, Promise, Reflect, Uint8Array};
    use wasm_bindgen::{closure::Closure, JsCast as _, JsValue};

    pub(super) struct Hooks {
        pub(super) changed: Function,
        pub(super) undo: Function,
    }

    pub(super) fn call(pick: impl FnOnce(&Hooks) -> &Function, arg: &JsValue) {
        if let Some(hook) =
            SESSION.with_borrow(|s| s.hooks.as_ref().map(|hooks| pick(hooks).clone()))
        {
            let _ = hook.call1(&JsValue::NULL, arg);
        }
    }

    /// Offers the adapter as `globalThis.playgroundLiveAdapter`, and to `globalThis.playgroundLive.attach` when the
    /// shell is there already. `with_app` runs a closure on the running app (false: not running); `repaint` asks for a
    /// frame. A page without the shell never connects.
    pub fn attach<A: Live + 'static>(
        format: &str,
        with_app: impl Fn(&mut dyn FnMut(&mut A)) -> bool + 'static,
        repaint: impl Fn() + 'static,
    ) -> Result<(), JsValue> {
        let with_app = std::rc::Rc::new(with_app);
        SESSION.with_borrow_mut(|s| s.repaint = Some(Box::new(repaint)));
        let adapter = Object::new();
        let set =
            |name: &str, value: JsValue| Reflect::set(&adapter, &name.into(), &value).map(drop);
        set("format", format.into())?;
        let app = with_app.clone();
        let checkpoint = move || -> Result<Uint8Array, JsValue> {
            let mut bytes = None;
            app(&mut |app: &mut A| bytes = Some(super::checkpoint(app)));
            Ok(bytes
                .ok_or("The app is not running")?
                .map_err(|e| JsValue::from_str(&e))?
                .as_slice()
                .into())
        };
        set(
            "checkpoint",
            Closure::<dyn Fn() -> _>::new(checkpoint).into_js_value(),
        )?;
        let merge = |base: Uint8Array,
                     current: Uint8Array,
                     edited: Uint8Array|
         -> Result<Uint8Array, JsValue> {
            let parse = |bytes: Uint8Array| super::parse(&bytes.to_vec());
            let merged = (|| A::live_merge(&parse(base)?, &parse(current)?, &parse(edited)?))();
            Ok(
                super::canonical(&merged.map_err(|e| JsValue::from_str(&e))?)
                    .as_slice()
                    .into(),
            )
        };
        set(
            "merge",
            Closure::<dyn Fn(_, _, _) -> _>::new(merge).into_js_value(),
        )?;
        let apply = |base: JsValue, edited: Uint8Array| -> Promise {
            let mut job = Some((
                base.dyn_ref::<Uint8Array>().map(Uint8Array::to_vec),
                edited.to_vec(),
            ));
            Promise::new(&mut |resolve, reject| {
                let Some((base, edited)) = job.take() else {
                    return;
                };
                super::queue(
                    base,
                    edited,
                    Box::new(move |result| {
                        let _ = match result {
                            Ok(None) => resolve.call0(&JsValue::NULL),
                            Ok(Some(replaced)) => resolve
                                .call1(&JsValue::NULL, &Uint8Array::from(replaced.as_slice())),
                            Err(e) => reject.call1(&JsValue::NULL, &JsValue::from_str(&e)),
                        };
                    }),
                );
            })
        };
        set(
            "apply",
            Closure::<dyn Fn(_, _) -> _>::new(apply).into_js_value(),
        )?;
        let connect = |hooks: JsValue| -> Result<(), JsValue> {
            let get = |name: &str| Reflect::get(&hooks, &name.into())?.dyn_into::<Function>();
            let hooks = Hooks {
                changed: get("changed")?,
                undo: get("undo")?,
            };
            SESSION.with_borrow_mut(|s| s.hooks = Some(hooks));
            super::connect();
            Ok(())
        };
        set(
            "connect",
            Closure::<dyn Fn(_) -> _>::new(connect).into_js_value(),
        )?;
        let app = with_app.clone();
        let disconnect = move || {
            super::disconnect();
            app(&mut |app: &mut A| app.live_disconnected());
        };
        set(
            "disconnect",
            Closure::<dyn Fn()>::new(disconnect).into_js_value(),
        )?;
        let global = js_sys::global();
        Reflect::set(&global, &"playgroundLiveAdapter".into(), &adapter)?;
        let attach = Reflect::get(&global, &"playgroundLive".into())
            .and_then(|live| Reflect::get(&live, &"attach".into()))
            .ok()
            .and_then(|attach| attach.dyn_into::<Function>().ok());
        if let Some(attach) = attach {
            attach.call1(&global, &adapter)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn m(b: Value, c: Value, e: Value) -> Result<Value, Error> {
        merge(&b, &c, &e, &["next_id"])
    }

    #[test]
    fn separate_fields_merge_and_the_same_field_conflicts_even_with_equal_values() {
        let b = json!({"title": "a", "size": 1, "view": {"zoom": 1}});
        let c = json!({"title": "b", "size": 1, "view": {"zoom": 1}});
        let e = json!({"title": "a", "size": 2, "view": {"zoom": 1}});
        assert_eq!(
            m(b.clone(), c.clone(), e).unwrap(),
            json!({"title": "b", "size": 2, "view": {"zoom": 1}})
        );
        assert!(m(b.clone(), c.clone(), c.clone())
            .unwrap_err()
            .contains("/title"));
        let removed = json!({"size": 1, "view": {"zoom": 1}});
        assert!(m(
            b.clone(),
            removed,
            json!({"title": "c", "size": 1, "view": {"zoom": 1}})
        )
        .is_err());
    }

    #[test]
    fn keyed_items_merge_by_id_keep_additions_in_place_and_take_one_sides_reorder() {
        let item = |id: u64, v: &str| json!({"id": id, "v": v});
        let b = json!({"items": [item(1, "a"), item(2, "b"), item(3, "c")], "next_id": 4});
        // One side adds 4 after 2; the other removes 1, edits 2, reorders and adds 5 after 2.
        let c = json!({"items": [item(1, "a"), item(2, "b"), item(4, "new c"), item(3, "c")], "next_id": 5});
        let e = json!({"items": [item(3, "c"), item(2, "B"), item(5, "new e")], "next_id": 6});
        let out = m(b.clone(), c, e).unwrap();
        assert_eq!(out["next_id"], 6);
        assert_eq!(
            out["items"],
            json!([
                item(3, "c"),
                item(2, "B"),
                item(5, "new e"),
                item(4, "new c")
            ])
        );
        // 1 was edited on one side and removed on the other.
        let edited_one = json!({"items": [item(1, "A"), item(2, "b"), item(3, "c")], "next_id": 4});
        let removed_one = json!({"items": [item(2, "b"), item(3, "c")], "next_id": 4});
        assert!(m(b.clone(), edited_one, removed_one).is_err());
        // Two different reorders conflict.
        let r1 = json!({"items": [item(2, "b"), item(1, "a"), item(3, "c")], "next_id": 4});
        let r2 = json!({"items": [item(1, "a"), item(3, "c"), item(2, "b")], "next_id": 4});
        assert!(m(b.clone(), r1, r2).unwrap_err().contains("order"));
        // The same new id from both sides is a concurrent allocation.
        let c = json!({"items": [item(1, "a"), item(2, "b"), item(3, "c"), item(4, "x")], "next_id": 5});
        let e = json!({"items": [item(1, "a"), item(2, "b"), item(3, "c"), item(4, "y")], "next_id": 5});
        assert!(m(b, c, e).is_err());
    }

    #[test]
    fn canonical_bytes_do_not_depend_on_key_order_and_unkeyed_arrays_are_single_values() {
        let a: Value = serde_json::from_str(r#"{"b":1,"a":{"y":2,"x":[3,1]}}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"a":{"x":[3,1],"y":2},"b":1}"#).unwrap();
        assert_eq!(canonical(&a), canonical(&b));
        assert_eq!(canonical(&a), br#"{"a":{"x":[3,1],"y":2},"b":1}"#);
        let points = |v: Vec<u32>| json!({"points": v});
        assert!(m(points(vec![1, 2]), points(vec![1, 3]), points(vec![0, 2])).is_err());
    }

    struct Doc {
        doc: Value,
        busy: bool,
    }

    impl Live for Doc {
        fn live_document(&self) -> Value {
            self.doc["shared"].clone()
        }
        fn live_adopt(&mut self, document: Value) -> Result<(), Error> {
            self.doc["shared"] = document;
            Ok(())
        }
        fn live_quiet(&self) -> bool {
            !self.busy
        }
    }

    #[test]
    fn remote_changes_wait_for_quiet_keep_views_and_only_shared_changes_report() {
        let mut app = Doc {
            doc: json!({"shared": {"a": 1, "b": 1}, "view": 1}),
            busy: true,
        };
        connect();
        let base = canonical(&app.live_document());
        let done = std::rc::Rc::new(std::cell::RefCell::new(None));
        let to = done.clone();
        queue(
            Some(base),
            canonical(&json!({"a": 2, "b": 1})),
            Box::new(move |r| *to.borrow_mut() = Some(r)),
        );
        app.doc["shared"]["b"] = json!(3);
        frame(&mut app);
        assert!(done.borrow().is_none(), "a busy app waits");
        assert_eq!(
            checkpoint(&app),
            Err("busy".into()),
            "no half-done gesture is read"
        );
        app.busy = false;
        frame(&mut app);
        assert_eq!(*done.borrow(), Some(Ok(None)));
        assert_eq!(app.doc, json!({"shared": {"a": 2, "b": 3}, "view": 1}));
        let (changes, _) = activity();
        app.doc["view"] = json!(2);
        frame(&mut app);
        assert_eq!(activity().0, changes, "views are not shared");
        assert!(undo(true));
        assert_eq!(activity().1, [true]);
        let mut next = 7;
        let (a, b) = (fresh_id(&mut next), fresh_id(&mut next));
        assert!(
            a != b && a >> 52 == 1 && next == 9,
            "connected ids are peer-unique and the counter still counts"
        );
        disconnect();
        assert!(!undo(false));
        assert_eq!(fresh_id(&mut next), 9);
    }
}
