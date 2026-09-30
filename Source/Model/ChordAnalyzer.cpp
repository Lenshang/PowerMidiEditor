#include "ChordAnalyzer.h"

#include <algorithm>
#include <array>
#include <cmath>

namespace pme
{

namespace
{
// Mirrors the UI's CHORD_QUALITIES order (frontend render.ts) — quality
// indices in ChordEvent index into that table. Append only, never reorder.
struct QualityTemplate
{
    std::array<int, 4> intervals;
    int count;
};
constexpr QualityTemplate kQualities[] = {
    { { 0, 4, 7, 0 }, 3 },   // 0 maj
    { { 0, 3, 7, 0 }, 3 },   // 1 min
    { { 0, 3, 6, 0 }, 3 },   // 2 dim
    { { 0, 4, 8, 0 }, 3 },   // 3 aug
    { { 0, 4, 7, 10 }, 4 },  // 4 7
    { { 0, 4, 7, 11 }, 4 },  // 5 maj7
    { { 0, 3, 7, 10 }, 4 },  // 6 min7
    { { 0, 5, 7, 0 }, 3 },   // 7 sus4
    { { 0, 2, 7, 0 }, 3 },   // 8 sus2
    { { 0, 4, 7, 14 }, 4 },  // 9 add9 (14 = major ninth above the root)
    { { 0, 7, 0, 0 }, 2 },   // 10 5 (power chord)
    { { 0, 4, 7, 9 }, 4 },   // 11 6
    { { 0, 3, 7, 9 }, 4 },   // 12 m6
    { { 0, 3, 6, 10 }, 4 },  // 13 m7b5
    { { 0, 3, 6, 9 }, 4 },   // 14 dim7
    { { 0, 5, 7, 10 }, 4 },  // 15 7sus4
};
constexpr int kNumQualities = (int) std::size (kQualities);
} // namespace

std::vector<ChordEvent> ChordAnalyzer::analyze (const std::vector<Note>& notes)
{
    return analyze (notes, Params{});
}

std::vector<ChordEvent> ChordAnalyzer::analyze (const std::vector<Note>& notes, const Params& p)
{
    std::vector<ChordEvent> out;
    if (notes.empty())
        return out;

    double totalEnd = 0.0;
    for (const auto& n : notes)
        if (! n.muted)
            totalEnd = std::max (totalEnd, n.start + n.length);
    const int numSegs = (int) std::ceil (totalEnd / p.segPpq - 1e-9);
    if (numSegs <= 0)
        return out;

    int lastRoot = -1, lastQuality = -1;
    int openChord = -1; // index into out of the chord currently being extended

    for (int seg = 0; seg < numSegs; ++seg)
    {
        const double b0 = seg * p.segPpq;
        const double b1 = b0 + p.segPpq;

        // duration-weighted pitch-class profile of the notes sounding in this bar
        std::array<double, 12> weight {};
        double total = 0.0;
        int distinct = 0;
        double bassPc = -1.0;
        int lowestPitch = 1 << 20;
        for (const auto& n : notes)
        {
            if (n.muted || n.length <= 0.0)
                continue;
            const double s = std::max (n.start, b0);
            const double e = std::min (n.start + n.length, b1);
            if (e <= s)
                continue;
            const int pc = ((n.pitch % 12) + 12) % 12;
            if (weight[pc] <= 0.0)
                distinct++;
            weight[pc] += e - s;
            total += e - s;
            if (n.pitch < lowestPitch)
            {
                lowestPitch = n.pitch;
                bassPc = pc;
            }
        }

        // single-note / silent bar: no chord here (breaks any run)
        if (distinct < 2 || total <= 0.0)
        {
            lastRoot = -1;
            lastQuality = -1;
            openChord = -1;
            continue;
        }

        // score every (root, quality) template against the profile.
        // A template tone counts as present only when it carries a real
        // share of the window (toneShare): a brief passing tone can neither
        // complete a richer template's presence nor inflate its coverage.
        const double toneFloor = p.toneShare * total;
        int bestRoot = -1, bestQuality = -1;
        double bestScore = -1.0;
        for (int root = 0; root < 12; ++root)
        {
            for (int qi = 0; qi < kNumQualities; ++qi)
            {
                double in = 0.0;
                int present = 0;
                for (int k = 0; k < kQualities[qi].count; ++k)
                {
                    const int pc = (root + kQualities[qi].intervals[k]) % 12;
                    if (weight[pc] >= toneFloor)
                    {
                        in += weight[pc];
                        present++;
                    }
                }
                const double coverage = in / total;
                const double presence = (double) present / (double) kQualities[qi].count;
                if (coverage < p.minCoverage || presence < p.minPresence)
                    continue;
                double score = 0.5 * coverage + 0.5 * presence;
                // a template whose every tone sounds explains the window more
                // specifically than its triadic subset
                if (present == kQualities[qi].count)
                    score += 0.02;
                if (root == (int) bassPc)
                    score += 0.05; // the lowest note supports the root
                if (score > bestScore)
                {
                    bestScore = score;
                    bestRoot = root;
                    bestQuality = qi;
                }
            }
        }

        if (bestQuality < 0)
        {
            // nothing fits this window: end the current run
            lastRoot = -1;
            lastQuality = -1;
            openChord = -1;
            continue;
        }

        if (bestRoot == lastRoot && bestQuality == lastQuality && openChord >= 0
            && openChord < (int) out.size())
        {
            out[(size_t) openChord].length = b1 - out[(size_t) openChord].start; // extend
        }
        else
        {
            ChordEvent c;
            c.start = b0;
            c.length = p.segPpq;
            c.root = bestRoot;
            c.quality = bestQuality;
            out.push_back (c);
            openChord = (int) out.size() - 1;
        }
        lastRoot = bestRoot;
        lastQuality = bestQuality;
    }

    // drop fragments shorter than the minimum (single short windows between runs)
    const auto keptEnd = std::remove_if (out.begin(), out.end(),
        [&p] (const ChordEvent& c) { return c.length + 1e-9 < p.minLength; });
    out.erase (keptEnd, out.end());
    return out;
}

} // namespace pme
