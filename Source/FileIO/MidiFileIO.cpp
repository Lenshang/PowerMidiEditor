#include "MidiFileIO.h"

namespace pme
{

static constexpr int ticksPerQuarter = 960; // exact 15 ticks per 1/64-ppq curve step
static constexpr double curveStepPpq = 1.0 / 64.0;
static constexpr double curveEpsilon = 1e-9;

static double tickToQuarter (int tick) { return (double) tick / (double) ticksPerQuarter; }

//==============================================================================
// A standard MIDI file has no curve semantics — only discrete events. Bake the
// document's piecewise-linear controller/pitch-bend ramps into dense events so
// the bend actually bends in whatever consumes the file. Values hold flat
// before the first and after the last knot; unchanged values are not repeated.
// `lane` must be sorted by time.
static void bakeRamp (juce::MidiMessageSequence& seq,
                      const std::vector<double>& knotTimes, const std::vector<int>& knotValues,
                      int maxValue, int neutralValue,
                      const std::function<juce::MidiMessage (int, int)>& makeMsg)
{
    if (knotTimes.empty())
        return;

    // sample times: fine grid + exact knot times, merged and deduped
    std::vector<double> times;
    const double lastTime = knotTimes.back();
    for (double t = 0.0; t <= lastTime + curveEpsilon; t += curveStepPpq)
        times.push_back (t);
    times.insert (times.end(), knotTimes.begin(), knotTimes.end());
    std::sort (times.begin(), times.end());
    times.erase (std::unique (times.begin(), times.end(),
                              [] (double a, double b) { return b - a < curveEpsilon; }),
                 times.end());

    size_t seg = 0; // current segment: knotTimes[seg] <= t < knotTimes[seg+1]
    int lastSent = -1;
    for (const double t : times)
    {
        while (seg + 1 < knotTimes.size() && knotTimes[seg + 1] <= t + curveEpsilon)
            ++seg;

        int v;
        if (t < knotTimes.front() - curveEpsilon)
            v = neutralValue; // rests at neutral before the first knot
        else if (seg + 1 >= knotTimes.size())
            v = knotValues.back();  // hold the last knot's value rightward
        else
        {
            const double span = knotTimes[seg + 1] - knotTimes[seg];
            const double a = span > curveEpsilon ? (t - knotTimes[seg]) / span : 0.0;
            v = (int) juce::roundToInt (knotValues[seg]
                                        + (knotValues[seg + 1] - knotValues[seg]) * juce::jlimit (0.0, 1.0, a));
        }
        v = juce::jlimit (0, maxValue, v);
        if (v != lastSent)
        {
            lastSent = v;
            seq.addEvent (makeMsg (v, 0), (int) juce::roundToInt (t * ticksPerQuarter));
        }
    }
}

static void bakeCcLanes (juce::MidiMessageSequence& seq, const std::vector<ControllerEvent>& ccs)
{
    // one ramp per (channel, controller number); snapshot arrays are sorted by time
    for (const auto& start : ccs)
    {
        // skip lanes already baked (same channel + cc seen earlier)
        bool seen = false;
        for (const auto& earlier : ccs)
        {
            if (&earlier == &start)
                break;
            if (earlier.channel == start.channel && earlier.cc == start.cc)
                seen = true;
        }
        if (seen)
            continue;

        std::vector<double> times;
        std::vector<int> values;
        for (const auto& e : ccs)
            if (e.channel == start.channel && e.cc == start.cc)
            {
                times.push_back (e.ppq);
                values.push_back (e.value);
            }
        bakeRamp (seq, times, values, 127, 0,
                  [&start] (int v, int) { return juce::MidiMessage::controllerEvent (start.channel, start.cc, v); });
    }
}

static void bakePbLanes (juce::MidiMessageSequence& seq, const std::vector<PitchBendEvent>& pbs)
{
    for (const auto& start : pbs)
    {
        bool seen = false;
        for (const auto& earlier : pbs)
        {
            if (&earlier == &start)
                break;
            if (earlier.channel == start.channel)
                seen = true;
        }
        if (seen)
            continue;

        std::vector<double> times;
        std::vector<int> values;
        for (const auto& e : pbs)
            if (e.channel == start.channel)
            {
                times.push_back (e.ppq);
                values.push_back (e.value & 0x3fff);
            }
        bakeRamp (seq, times, values, 16383, 8192,
                  [&start] (int v, int) { return juce::MidiMessage::pitchWheel (start.channel, v); });
    }
}

//==============================================================================
bool MidiFileIO::exportMidi (const DocumentSnapshot& snapshot, const juce::File& file)
{
    juce::MidiFile mf;
    mf.setTicksPerQuarterNote (ticksPerQuarter);

    juce::MidiMessageSequence seq;

    for (const auto& n : snapshot.notes)
    {
        if (n.muted)
            continue;
        const int on = (int) juce::roundToInt (n.start * ticksPerQuarter);
        const int off = (int) juce::roundToInt ((n.start + n.length) * ticksPerQuarter);
        seq.addEvent (juce::MidiMessage::noteOn (n.channel, n.pitch, n.velocity), on);
        seq.addEvent (juce::MidiMessage::noteOff (n.channel, n.pitch), juce::jmax (on + 1, off));
    }

    // Materialize articulations exactly like live playback: when a tagged
    // note switches to a different articulation, emit its keyswitch (a short
    // note slightly before) and/or its CC value so the exported file drives
    // the downstream instrument the same way the plugin does.
    {
        int currentArt[16];
        for (auto& c : currentArt)
            c = -1;
        for (const auto& n : snapshot.notes)
        {
            if (n.muted || n.art < 0)
                continue;
            const int ch = juce::jlimit (1, 16, n.channel) - 1;
            if (currentArt[ch] == n.art)
                continue;
            const auto* art = snapshot.findArticulation ((juce::uint32) n.art);
            if (art == nullptr)
                continue;
            currentArt[ch] = n.art;
            const int on = (int) juce::roundToInt (n.start * ticksPerQuarter);
            const int ksTick = juce::jmax (0, on - 15); // ~1/64 ppq before the note
            if (art->keyswitch >= 0)
            {
                seq.addEvent (juce::MidiMessage::noteOn (n.channel, art->keyswitch, 1.0f), ksTick);
                seq.addEvent (juce::MidiMessage::noteOff (n.channel, art->keyswitch), ksTick + 20);
            }
            if (art->cc >= 0)
                seq.addEvent (juce::MidiMessage::controllerEvent (n.channel, art->cc, art->ccValue), ksTick);
        }
    }

    // Lyrics: SMF FF05 Lyric meta at each tagged note-on — this is the
    // interchange path vocal synths (Synthesizer V, VOCALOID, CeVIO…) read.
    for (const auto& n : snapshot.notes)
    {
        if (n.muted || n.lyric.isEmpty())
            continue;
        const int on = (int) juce::roundToInt (n.start * ticksPerQuarter);
        seq.addEvent (juce::MidiMessage::textMetaEvent (5, n.lyric), on);
    }

    // Controllers + pitch bend: bake the piecewise-linear ramps into the file.
    bakeCcLanes (seq, snapshot.ccs);
    bakePbLanes (seq, snapshot.pbs);

    mf.addTrack (seq);

    juce::FileOutputStream stream (file);
    if (! stream.openedOk())
        return false;
    stream.setPosition (0);
    stream.truncate();
    return mf.writeTo (stream);
}

//==============================================================================
bool MidiFileIO::importMidi (const juce::File& file, ImportResult& out)
{
    juce::FileInputStream stream (file);
    if (! stream.openedOk())
        return false;
    return importFromStream (stream, out);
}

bool MidiFileIO::importMidiFromMemory (const void* data, size_t numBytes, ImportResult& out)
{
    if (data == nullptr || numBytes == 0)
        return false;
    juce::MemoryInputStream stream (data, numBytes, false);
    return importFromStream (stream, out);
}

bool MidiFileIO::importFromStream (juce::InputStream& stream, ImportResult& out)
{
    juce::MidiFile mf;
    if (! mf.readFrom (stream))
        return false;

    const double ticksPerQ = mf.getTimeFormat(); // positive = ticks per quarter
    if (ticksPerQ <= 0)
        return false; // SMPTE timing not supported
    const double scale = 1.0 / ticksPerQ;

    struct Pending { double start; float velocity; int channel; };
    std::map<std::pair<int, int>, Pending> pendingNotes; // (channel, pitch) -> start
    std::map<int, juce::String> lyricsByTick;            // SMF FF05 (and FF01) lyrics

    auto metaText = [] (const juce::MidiMessage& m) -> juce::String
    {
        if (! m.isMetaEvent())
            return {};
        const int type = m.getMetaEventType();
        if (type != 0x05 && type != 0x01) // lyric / text
            return {};
        return m.getTextFromTextMetaEvent().trim();
    };

    for (int track = 0; track < mf.getNumTracks(); ++track)
    {
        auto* seq = mf.getTrack (track);
        if (seq == nullptr)
            continue;
        for (int i = 0; i < seq->getNumEvents(); ++i)
        {
            auto* holder = seq->getEventPointer (i);
            if (holder == nullptr)
                continue;
            const auto msg = holder->message;
            const double t = tickToQuarter ((int) holder->message.getTimeStamp());

            if (msg.isMetaEvent())
            {
                auto text = metaText (msg);
                if (text.isNotEmpty())
                    lyricsByTick[(int) holder->message.getTimeStamp()] = text;
                continue;
            }

            if (msg.isNoteOn())
            {
                pendingNotes[{ msg.getChannel(), msg.getNoteNumber() }] = { t, msg.getFloatVelocity(), msg.getChannel() };
            }
            else if (msg.isNoteOff() || (msg.isNoteOn() && msg.getVelocity() == 0))
            {
                auto key = std::make_pair (msg.getChannel(), msg.getNoteNumber());
                auto it = pendingNotes.find (key);
                if (it == pendingNotes.end())
                    continue;
                Note n;
                n.pitch = msg.getNoteNumber();
                n.start = it->second.start;
                n.length = juce::jmax (0.05, t - it->second.start);
                n.velocity = juce::jlimit (0.05f, 1.0f, it->second.velocity);
                n.channel = msg.getChannel();
                out.notes.push_back (n);
                pendingNotes.erase (it);
            }
            else if (msg.isController())
            {
                ControllerEvent e;
                e.cc = msg.getControllerNumber();
                e.channel = msg.getChannel();
                e.ppq = t;
                e.value = msg.getControllerValue();
                out.ccs.push_back (e);
            }
            else if (msg.isPitchWheel())
            {
                PitchBendEvent e;
                e.channel = msg.getChannel();
                e.ppq = t;
                e.value = msg.getPitchWheelValue();
                out.pbs.push_back (e);
            }
        }
    }

    // attach lyrics to the note starting at each lyric tick
    for (auto& n : out.notes)
    {
        const int tick = (int) juce::roundToInt (n.start * ticksPerQ);
        auto it = lyricsByTick.find (tick);
        if (it != lyricsByTick.end())
            n.lyric = it->second;
    }

    // close any note left hanging at the end of the file
    for (auto& [key, p] : pendingNotes)
    {
        Note n;
        n.pitch = key.second;
        n.start = p.start;
        n.length = 0.25;
        n.velocity = juce::jlimit (0.05f, 1.0f, p.velocity);
        n.channel = p.channel;
        out.notes.push_back (n);
    }

    auto sortByTime = [] (auto& vec, auto getT)
    {
        std::sort (vec.begin(), vec.end(), [getT] (const auto& a, const auto& b) { return getT (a) < getT (b); });
    };
    sortByTime (out.notes, [] (const Note& n) { return n.start; });
    sortByTime (out.ccs, [] (const ControllerEvent& e) { return e.ppq; });
    sortByTime (out.pbs, [] (const PitchBendEvent& e) { return e.ppq; });
    return true;
}

} // namespace pme
