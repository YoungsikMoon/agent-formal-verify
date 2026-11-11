// Copyright (c) 2026 Michael Denyer
// SPDX-License-Identifier: GPL-3.0-only
//
// The harnesses in `proofs` check `claim` and `consume` of a bounded queue with
// ordered output. To adapt them, replace this comment with the production
// source files and line ranges the harnesses call, the functions they cover,
// the commit they were read at as `Source read at <commit>`, and each caller
// constraint and stub assumption.

#[derive(Clone, Copy)]
pub struct State {
    pub next: u16,
    pub consumed: u16,
}

pub fn invariant(window: u16, state: State) -> bool {
    state.consumed <= state.next && state.next <= state.consumed + window
}

pub fn claim(window: u16, state: State) -> Option<State> {
    if state.next < state.consumed + window {
        Some(State { next: state.next + 1, ..state })
    } else {
        None
    }
}

pub fn consume(state: State) -> Option<State> {
    if state.consumed < state.next {
        Some(State { consumed: state.consumed + 1, ..state })
    } else {
        None
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    // Counters are at most 6 and the window is 1 or 2. No callee is stubbed.
    fn inputs() -> (u16, State) {
        let window: u16 = kani::any();
        let state = State { next: kani::any(), consumed: kani::any() };
        kani::assume(window > 0 && window <= 2);
        kani::assume(state.next <= 6 && state.consumed <= 6);
        kani::assume(invariant(window, state));
        (window, state)
    }

    #[kani::proof]
    #[kani::unwind(2)]
    fn claim_keeps_invariant() {
        let (window, state) = inputs();
        kani::cover!(state.next == state.consumed + window, "window full");
        if let Some(after) = claim(window, state) {
            assert!(invariant(window, after));
        }
    }

    #[kani::proof]
    #[kani::unwind(2)]
    fn consume_keeps_invariant() {
        let (window, state) = inputs();
        kani::cover!(state.next == state.consumed, "queue empty");
        if let Some(after) = consume(state) {
            assert!(invariant(window, after));
        }
    }
}
