#pragma once

#include "../Model/MidiClipDocument.h"

#include <algorithm>
#include <vector>

namespace pme
{

// Builds an export-ready snapshot containing ONLY the given notes, time
// shifted so the earliest selected note starts at 0 (the "drag out
// selection" workflow: first selected note = beginning of the file).
// Curves/chords are dropped — the selection is about the notes.
inline DocumentSnapshot makeSelectionSnapshot (
    const DocumentSnapshot& s,
    const std::vector<juce::uint32>& ids,
    bool& ok)
{
    ok = false;
    DocumentSnapshot out = s;
    out.notes.clear();
    out.ccs.clear();
    out.pbs.clear();
    out.chords.clear();

    double minStart = 1e9;
    for (const auto& n : s.notes)
    {
        if (n.muted)
            continue;
        if (std::find (ids.begin(), ids.end(), n.id) == ids.end())
            continue;
        minStart = std::min (minStart, n.start);
    }
    if (minStart > 1e8)
        return out; // no matching notes -> ok stays false

    for (const auto& n : s.notes)
    {
        if (std::find (ids.begin(), ids.end(), n.id) == ids.end())
            continue;
        auto shifted = n;
        shifted.start = std::max (0.0, n.start - minStart);
        out.notes.push_back (shifted);
        ok = true;
    }
    std::sort (out.notes.begin(), out.notes.end(), [] (const Note& a, const Note& b)
    {
        if (a.start != b.start)
            return a.start < b.start;
        return a.id < b.id;
    });
    out.revision = s.revision + 1;
    return out;
}

} // namespace pme
