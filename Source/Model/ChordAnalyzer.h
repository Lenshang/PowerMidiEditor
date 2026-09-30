#pragma once

#include "MidiClipDocument.h"

#include <vector>

namespace pme
{

// Rule-based chord detection for the midi browser "load" flow (the same
// approach Cubase's chord track and music21 use for MIDI: template matching
// over pitch-class profiles — no ML, no dependencies). Segments the note
// timeline into BEATS, scores each segment's duration-weighted pitch-class
// profile against the chord-quality templates the UI can display (frontend
// render.ts CHORD_QUALITIES — keep the two tables in the same order), then
// aggregates: adjacent identical chords merge into one event. A template
// tone only counts as present when it carries a real share of the segment
// (toneShare) so short passing tones cannot complete a richer template.
class ChordAnalyzer
{
public:
    struct Params
    {
        double segPpq = 1.0;       // detection window: one beat (4/4 assumed)
        double minCoverage = 0.55; // template must explain this share of the window
        double minPresence = 0.5;  // template must have at least this share of its own pitches present
        double toneShare = 0.12;   // a template tone must hold ≥ this share of the window to count
        double minLength = 1.0;    // drop shorter chords (ppq) after merging
    };

    static std::vector<ChordEvent> analyze (const std::vector<Note>& notes,
                                            const Params& p = {});
};

} // namespace pme
