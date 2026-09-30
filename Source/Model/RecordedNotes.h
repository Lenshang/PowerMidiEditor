#pragma once

#include "MidiClipDocument.h"

#include <cmath>
#include <map>
#include <vector>

namespace pme
{

// One raw recorded MIDI event (audio thread -> message thread ring buffer).
// Times are quarter notes at the recording tempo.
struct RecEvent { bool on; int pitch, channel; float velocity; double ppq; };

// Pairs ordered note-on/off events into document notes. The note's length is
// the ACTUAL held duration (note-off time) — recording must capture how long
// the key was down — floored at one grid cell so a very short tap still
// produces a visible, clickable note. With quantize on, the start is floored
// to the grid and the end snapped to the nearest grid line.
//
// `pending` must live across calls (processor member): the drain timer runs
// much faster than a held note, so a note-on is usually paired by a LATER
// call's note-off.
inline std::vector<Note> notesFromRecordedEvents (
    const std::vector<RecEvent>& events, bool quantize, double grid,
    std::map<int, std::pair<double, float>>& pending)
{
    std::vector<Note> out;
    grid = juce::jmax (0.03125, grid);
    for (const auto& ev : events)
    {
        const int key = ev.pitch * 16 + ev.channel;
        if (ev.on)
        {
            pending[key] = { ev.ppq, ev.velocity };
            continue;
        }
        auto it = pending.find (key);
        if (it == pending.end())
            continue;
        Note n;
        n.pitch = ev.pitch;
        n.channel = ev.channel;
        n.velocity = juce::jlimit (0.05f, 1.0f, it->second.second);
        n.start = it->second.first;
        double end = ev.ppq;
        if (quantize)
        {
            n.start = std::floor (n.start / grid) * grid;
            end = std::round (end / grid) * grid;
        }
        n.length = juce::jmax (grid, end - n.start);
        out.push_back (n);
        pending.erase (it);
    }
    return out;
}

} // namespace pme
