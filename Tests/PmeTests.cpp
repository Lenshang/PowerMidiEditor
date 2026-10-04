// Console unit tests for the document model and the playback engine.
// Run via: ctest or directly (returns non-zero on failure).
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include "../Source/Model/MidiClipDocument.h"
#include "../Source/Model/RecordedNotes.h"
#include "../Source/Model/SharedChordTrack.h"
#include "../Source/Playback/PlaybackEngine.h"
#include "../Source/FileIO/MidiFileIO.h"
#include "../Source/Model/ChordAnalyzer.h"
#include "../Source/FileIO/ExpressionMapIO.h"
#include "../Source/FileIO/DrumMapIO.h"
#include "../Source/FileIO/SelectionSnapshot.hpp"

using namespace pme;

static int failures = 0;

#define CHECK(cond)                                                        \
    do                                                                     \
    {                                                                      \
        if (! (cond))                                                      \
        {                                                                  \
            std::cerr << "FAIL @ line " << __LINE__ << ": " #cond "\n";    \
            ++failures;                                                    \
        }                                                                  \
    } while (false)

//==============================================================================
static void testDocumentUndoRedo()
{
    MidiClipDocument doc;
    Note a; a.pitch = 60; a.start = 0.0; a.length = 0.5;
    Note b; b.pitch = 64; b.start = 0.5; b.length = 0.5;

    doc.beginTransaction ("add two");
    doc.addNote (a);
    doc.addNote (b);
    doc.commitTransaction();
    CHECK (doc.getSnapshot()->notes.size() == 2);
    CHECK (doc.canUndo());

    doc.undo();
    CHECK (doc.getSnapshot()->notes.empty());
    doc.redo();
    CHECK (doc.getSnapshot()->notes.size() == 2);

    // move note via update
    auto firstId = doc.getSnapshot()->notes[0].id;
    Note moved = doc.getSnapshot()->notes[0];
    moved.start = 2.0;
    doc.beginTransaction ("move");
    doc.updateNotes ({ moved });
    doc.commitTransaction();
    CHECK (doc.getSnapshot()->findNote (firstId)->start == 2.0);

    doc.undo();
    CHECK (doc.getSnapshot()->findNote (firstId)->start == 0.0);

    // remove
    doc.beginTransaction ("remove");
    doc.removeNotes ({ firstId });
    doc.commitTransaction();
    CHECK (doc.getSnapshot()->notes.size() == 1);
    doc.undo();
    CHECK (doc.getSnapshot()->notes.size() == 2);

    // revision always increments
    auto r0 = doc.getRevision();
    doc.undo();
    auto r1 = doc.getRevision();
    CHECK (r1 > r0);
}

static void testDocumentJson()
{
    MidiClipDocument doc;
    Note n; n.pitch = 72; n.start = 1.25; n.length = 0.75; n.velocity = 0.5f; n.channel = 3;
    doc.beginTransaction ("x");
    doc.addNote (n);
    doc.commitTransaction();

    auto v = doc.toVar();
    MidiClipDocument doc2;
    doc2.loadFromVar (v);
    CHECK (doc2.getSnapshot()->notes.size() == 1);
    const auto& n2 = doc2.getSnapshot()->notes[0];
    CHECK (n2.pitch == 72 && n2.start == 1.25 && n2.length == 0.75);
    CHECK (std::abs (n2.velocity - 0.5f) < 1e-6f && n2.channel == 3);

    auto json = MidiClipDocument::snapshotToJson (*doc2.getSnapshot());
    CHECK (json.getDynamicObject()->hasProperty ("notes"));
}

//==============================================================================
static EngineInputs makeInputs (const DocumentSnapshot& snap, int numSamples,
                                bool playing, double ppq, juce::int64 timeSamples,
                                double tempo = 120.0)
{
    EngineInputs in;
    in.snapshot = &snap;
    in.numSamples = numSamples;
    in.sampleRate = 48000.0;
    in.playing = playing;
    in.ppqValid = true;
    in.ppq = ppq;
    in.tempo = tempo;
    in.timeValid = true;
    in.timeInSamples = timeSamples;
    return in;
}

static int countOn (const juce::MidiBuffer& m, int pitch)
{
    int c = 0;
    for (const auto i : m)
        if (i.getMessage().isNoteOn() && i.getMessage().getNoteNumber() == pitch)
            ++c;
    return c;
}

static int countOff (const juce::MidiBuffer& m, int pitch)
{
    int c = 0;
    for (const auto i : m)
        if (i.getMessage().isNoteOff() && i.getMessage().getNoteNumber() == pitch)
            ++c;
    return c;
}

static void testEngineScheduling()
{
    MidiClipDocument doc;
    Note a; a.pitch = 60; a.start = 0.0;  a.length = 0.5; a.velocity = 0.9f;
    Note b; b.pitch = 64; b.start = 1.0;  b.length = 1.0;
    Note c; c.pitch = 67; c.start = 10.0; c.length = 0.25;
    doc.beginTransaction ("t");
    doc.addNote (a); doc.addNote (b); doc.addNote (c);
    doc.commitTransaction();

    PlaybackEngine eng;
    juce::MidiBuffer out;
    auto snap = doc.getSnapshot();

    // ppqPerSample = (120/60)/48000 = 1/24000
    // block 1: samples 0..512, ppq [0, 0.0213)
    out.clear();
    eng.render (out, makeInputs (*snap, 512, true, 0.0, 512));
    CHECK (countOn (out, 60) == 1);      // note at 0.0 starts in this block
    CHECK (countOn (out, 64) == 0);
    CHECK (countOff (out, 60) == 0);

    // block 2: continuous time, ppq [0.5, 1.5)
    out.clear();
    eng.render (out, makeInputs (*snap, 24000, true, 0.5, 512 + 24000));
    CHECK (countOn (out, 64) == 1);      // starts at 1.0
    CHECK (countOff (out, 60) == 1);     // ends at 0.5
    CHECK (countOff (out, 64) == 0);

    // transport stop -> flush note-off for the still-sounding note 64
    out.clear();
    eng.render (out, makeInputs (*snap, 512, false, 1.5, 512 + 24000 + 512));
    CHECK (countOff (out, 64) == 1);
}

static void testEngineLoopWrap()
{
    MidiClipDocument doc;
    Note a; a.pitch = 60; a.start = 0.0; a.length = 4.0; // long note across loop
    doc.beginTransaction ("t");
    doc.addNote (a);
    doc.commitTransaction();
    auto snap = doc.getSnapshot();

    PlaybackEngine eng;
    juce::MidiBuffer out;

    // block 1: ppq [0, 1.5), playing inside loop 0..2
    EngineInputs in = makeInputs (*snap, 36000, true, 0.0, 0);
    in.loopValid = true;
    in.loopStartPpq = 0.0;
    in.loopEndPpq = 2.0;
    out.clear();
    eng.render (out, in);
    CHECK (countOn (out, 60) == 1);
    CHECK (countOff (out, 60) == 0);

    // block 2: ppq [1.5, 2.5) crosses the loop end -> note cut at the wrap
    out.clear();
    in = makeInputs (*snap, 24000, true, 1.5, 36000);
    in.loopValid = true;
    in.loopStartPpq = 0.0;
    in.loopEndPpq = 2.0;
    eng.render (out, in);
    CHECK (countOff (out, 60) == 1);
}

static void testAudition()
{
    MidiClipDocument doc;
    Note a; a.pitch = 60; a.start = 1.0; a.length = 0.5;
    doc.beginTransaction ("t");
    doc.addNote (a);
    doc.commitTransaction();
    auto snap = doc.getSnapshot();

    PlaybackEngine eng;
    eng.startAudition (0.5);
    juce::MidiBuffer out;
    // 0.5 ppq per block: [0.5, 1.0) -> nothing yet
    out.clear();
    eng.render (out, makeInputs (*snap, 12000, false, 0.0, 0));
    CHECK (countOn (out, 60) == 0);
    // [1.0, 1.5) -> the note at 1.0 fires
    out.clear();
    eng.render (out, makeInputs (*snap, 12000, false, 0.0, 12000));
    CHECK (countOn (out, 60) == 1);
    eng.stopAudition();
}

// Rule-based chord detection for the browser load flow: known triads must be
// named correctly, passing tones must not break the bar, and non-chord bars
// must split the run.
static void testChordAnalyzer()
{
    auto note = [] (int pitch, double start, double length)
    {
        Note n; n.pitch = pitch; n.start = start; n.length = length; return n;
    };
    std::vector<Note> notes;

    // bar 1: C major (C4 E4 G4 full bar) + a short passing D — must stay Cmaj
    for (const int p : { 60, 64, 67 }) notes.push_back (note (p, 0.0, 4.0));
    notes.push_back (note (62, 2.0, 0.25));
    // bar 2: A minor (A3 C4 E4)
    for (const int p : { 57, 60, 64 }) notes.push_back (note (p, 4.0, 4.0));
    // bar 3: G7 (G3 B3 D4 F4)
    for (const int p : { 55, 59, 62, 65 }) notes.push_back (note (p, 8.0, 4.0));
    // bar 4: melody only (single line) — no chord, splits the run
    notes.push_back (note (72, 12.0, 4.0));
    // bar 5: C major again — new chord event after the gap
    for (const int p : { 60, 64, 67 }) notes.push_back (note (p, 16.0, 4.0));

    const auto chords = ChordAnalyzer::analyze (notes);

    // bars 1-3 detected, bar 4 (melody) skipped, bar 5 starts a new run
    CHECK (chords.size() == 4);
    if (chords.size() == 4)
    {
        CHECK (chords[0].root == 0 && chords[0].quality == 0);   // C maj
        CHECK (chords[0].start == 0.0 && chords[0].length == 4.0);
        CHECK (chords[1].root == 9 && chords[1].quality == 1);   // A min
        CHECK (chords[1].start == 4.0 && chords[1].length == 4.0);
        CHECK (chords[2].root == 7 && chords[2].quality == 4);   // G 7
        CHECK (chords[2].start == 8.0 && chords[2].length == 4.0);
        CHECK (chords[3].root == 0 && chords[3].quality == 0);   // C maj again
        CHECK (chords[3].start == 16.0 && chords[3].length == 4.0);
    }

    // two-bar Am run merges into one event
    std::vector<Note> run;
    for (const int p : { 57, 60, 64 }) run.push_back (note (p, 0.0, 8.0));
    const auto merged = ChordAnalyzer::analyze (run);
    CHECK (merged.size() == 1 && merged[0].length == 8.0 && merged[0].root == 9);
}

// Files are commonly NOT 960 TPQ (480 is the DAW norm): the importer must
// scale ticks by the file's own division, not the internal 960.
static void testImportTicksPerQuarter()
{
    juce::MidiFile mf;
    mf.setTicksPerQuarterNote (480);
    juce::MidiMessageSequence seq;
    seq.addEvent (juce::MidiMessage::noteOn (1, 60, 0.8f), 0);
    seq.addEvent (juce::MidiMessage::noteOff (1, 60), 480);
    seq.addEvent (juce::MidiMessage::noteOn (1, 62, 0.8f), 1920);   // bar 2
    seq.addEvent (juce::MidiMessage::noteOff (1, 62), 2400);
    mf.addTrack (seq);
    juce::MemoryOutputStream mb;
    mf.writeTo (mb, 0);

    MidiFileIO::ImportResult r;
    CHECK (MidiFileIO::importMidiFromMemory (mb.getData(), mb.getDataSize(), r));
    CHECK (r.notes.size() == 2);
    if (r.notes.size() == 2)
    {
        std::sort (r.notes.begin(), r.notes.end(),
            [] (const Note& a, const Note& b) { return a.start < b.start; });
        CHECK (std::abs (r.notes[0].start - 0.0) < 1e-9);
        CHECK (std::abs (r.notes[0].length - 1.0) < 1e-9);
        CHECK (std::abs (r.notes[1].start - 4.0) < 1e-9);   // was 2.0 with the hardcoded 960
    }
}

// The extended quality palette (sus2/add9/5/6/m6/m7b5/dim7/7sus4) must be
// recognized when its notes are present, and must not steal bars that belong
// to the original triads/sevenths.
static void testChordAnalyzerExtended()
{
    auto note = [] (int pitch, double start, double length)
    {
        Note n; n.pitch = pitch; n.start = start; n.length = length; return n;
    };

    {   // Csus2 (C D G) with C in the bass — sus2, not Gsus4 (same pcs)
        std::vector<Note> notes;
        for (const auto& [p, len] : { std::pair { 60, 4.0 }, std::pair { 62, 4.0 }, std::pair { 67, 4.0 } })
            notes.push_back (note (p, 0.0, len));
        const auto c = ChordAnalyzer::analyze (notes);
        CHECK (c.size() == 1 && c[0].root == 0 && c[0].quality == 8);
    }
    {   // Cadd9 (C E G D, all equal) — add9, not maj
        std::vector<Note> notes;
        for (const int p : { 60, 64, 67, 74 })
            notes.push_back (note (p, 0.0, 4.0));
        const auto c = ChordAnalyzer::analyze (notes);
        CHECK (c.size() == 1 && c[0].root == 0 && c[0].quality == 9);
    }
    {   // C5 power (only C + G) — 5, not maj (maj lacks the third)
        std::vector<Note> notes;
        notes.push_back (note (48, 0.0, 4.0));
        notes.push_back (note (67, 0.0, 4.0));
        const auto c = ChordAnalyzer::analyze (notes);
        CHECK (c.size() == 1 && c[0].root == 0 && c[0].quality == 10);
    }
    {   // C6 (C E G A) with C in the bass — 6, not Am7 (same pcs)
        std::vector<Note> notes;
        for (const int p : { 48, 64, 67, 69 })
            notes.push_back (note (p, 0.0, 4.0));
        const auto c = ChordAnalyzer::analyze (notes);
        CHECK (c.size() == 1 && c[0].root == 0 && c[0].quality == 11);
    }
    {   // Bm7b5 (B D F A)
        std::vector<Note> notes;
        for (const int p : { 59, 62, 65, 69 })
            notes.push_back (note (p, 0.0, 4.0));
        const auto c = ChordAnalyzer::analyze (notes);
        CHECK (c.size() == 1 && c[0].root == 11 && c[0].quality == 13);
    }
    {   // Cdim7 (C Eb Gb A) with C in the bass — symmetric pcs, bass decides
        std::vector<Note> notes;
        for (const int p : { 48, 63, 66, 69 })
            notes.push_back (note (p, 0.0, 4.0));
        const auto c = ChordAnalyzer::analyze (notes);
        CHECK (c.size() == 1 && c[0].root == 0 && c[0].quality == 14);
    }
    {   // plain Cmaj bar must NOT be stolen by 5 / 6 / add9
        std::vector<Note> notes;
        for (const int p : { 60, 64, 67 })
            notes.push_back (note (p, 0.0, 4.0));
        const auto c = ChordAnalyzer::analyze (notes);
        CHECK (c.size() == 1 && c[0].root == 0 && c[0].quality == 0);
    }
    {   // C E G B (all four) = Cmaj7, not plain maj — the full-presence bonus
        std::vector<Note> notes;
        for (const int p : { 60, 64, 67, 71 })
            notes.push_back (note (p, 0.0, 4.0));
        const auto c = ChordAnalyzer::analyze (notes);
        CHECK (c.size() == 1 && c[0].root == 0 && c[0].quality == 5);
    }
    {   // plain G7 bar must NOT be stolen by 7sus4 / dim7 / m7b5
        std::vector<Note> notes;
        for (const int p : { 55, 59, 62, 65 })
            notes.push_back (note (p, 0.0, 4.0));
        const auto c = ChordAnalyzer::analyze (notes);
        CHECK (c.size() == 1 && c[0].root == 7 && c[0].quality == 4);
    }
}

// Beat-level detection: a chord change in the MIDDLE of a bar must be
// caught (bar-level segmentation merged it into one wrong chord).
static void testChordAnalyzerMidBarChange()
{
    auto note = [] (int pitch, double start, double length)
    {
        Note n; n.pitch = pitch; n.start = start; n.length = length; return n;
    };
    std::vector<Note> notes;
    // beats 1-2: C major, beats 3-4: G7 — one bar, two chords
    for (const int p : { 60, 64, 67 }) notes.push_back (note (p, 0.0, 2.0));
    for (const int p : { 55, 59, 62, 65 }) notes.push_back (note (p, 2.0, 2.0));

    const auto chords = ChordAnalyzer::analyze (notes);
    CHECK (chords.size() == 2);
    if (chords.size() == 2)
    {
        CHECK (chords[0].root == 0 && chords[0].quality == 0);
        CHECK (std::abs (chords[0].start - 0.0) < 1e-9 && std::abs (chords[0].length - 2.0) < 1e-9);
        CHECK (chords[1].root == 7 && chords[1].quality == 4);
        CHECK (std::abs (chords[1].start - 2.0) < 1e-9 && std::abs (chords[1].length - 2.0) < 1e-9);
    }
}

static void testPreviewAndPanic()
{
    PlaybackEngine eng;
    eng.previewNote (72, 1, 0.8f);
    juce::MidiBuffer out;
    DocumentSnapshot empty;
    out.clear();
    eng.render (out, makeInputs (empty, 128, false, 0.0, 0));
    CHECK (countOn (out, 72) == 1);

    eng.panic();
    out.clear();
    eng.render (out, makeInputs (empty, 128, false, 0.0, 128));
    CHECK (countOff (out, 72) == 1);
}

static int countCc (const juce::MidiBuffer& m, int cc)
{
    int n = 0;
    for (const auto i : m)
        if (i.getMessage().isController() && i.getMessage().getControllerNumber() == cc)
            ++n;
    return n;
}

// Switching or stopping the file preview must kill EVERYTHING the file left
// sounding downstream — tracked note-offs alone are not enough when the file
// pressed the sustain pedal (CC64) mid-way: notes held by the pedal keep
// ringing. Switch/stop must emit pedal-off + All Notes Off + All Sound Off.
static void testPreviewSwitchStopsSound()
{
    // file A: one long note + sustain pedal pressed mid-note
    MidiClipDocument docA;
    Note na; na.pitch = 60; na.start = 0.0; na.length = 2.0;
    ControllerEvent ca; ca.cc = 64; ca.ppq = 0.5; ca.value = 127;
    docA.beginTransaction ("a");
    docA.addNote (na);
    docA.addCC (ca);
    docA.commitTransaction();
    auto snapA = docA.getSnapshot();

    // file B: one short note
    MidiClipDocument docB;
    Note nb; nb.pitch = 72; nb.start = 0.0; nb.length = 0.5;
    docB.beginTransaction ("b");
    docB.addNote (nb);
    docB.commitTransaction();
    auto snapB = docB.getSnapshot();

    DocumentSnapshot empty;
    PlaybackEngine eng;
    juce::MidiBuffer out;

    // 48000 Hz at 120 bpm → 1/24000 ppq per sample → 12000 samples = 0.5 ppq
    eng.setPreview (snapA.get(), 2.5);
    { EngineInputs in = makeInputs (empty, 12000, false, 0.0, 0);       in.previewSnapshot = snapA.get(); eng.render (out, in); }
    CHECK (countOn (out, 60) == 1);                    // A: note starts

    out.clear();
    { EngineInputs in = makeInputs (empty, 12000, false, 0.0, 12000);   in.previewSnapshot = snapA.get(); eng.render (out, in); }
    CHECK (countCc (out, 64) == 1);                    // A: pedal down at ppq 0.5

    // SWITCH to file B while A's note is sounding with the pedal down
    out.clear();
    eng.setPreview (snapB.get(), 1.0);
    { EngineInputs in = makeInputs (empty, 12000, false, 0.0, 24000);   in.previewSnapshot = snapB.get(); eng.render (out, in); }
    CHECK (countOff (out, 60) == 1);                   // tracked note-off for A
    CHECK (countCc (out, 64) >= 1);                    // pedal released
    CHECK (countCc (out, 123) == 16);                  // All Notes Off, all channels
    CHECK (countCc (out, 120) == 16);                  // All Sound Off, all channels
    CHECK (countOn (out, 72) == 1);                    // B starts after the kill

    // STOP the preview
    out.clear();
    eng.clearPreview();
    { EngineInputs in = makeInputs (empty, 12000, false, 0.0, 36000);   in.previewSnapshot = nullptr; eng.render (out, in); }
    CHECK (countCc (out, 123) == 16 && countCc (out, 120) == 16);
    CHECK (countCc (out, 64) >= 1);                    // pedal released again
}

// The browser must read the file's own tempo (earliest FF51 set-tempo meta)
// so the "file tempo" preview mode knows what to play at.
static void testImportTempo()
{
    auto usPerQ = [] (double bpm) { return (int) juce::roundToInt (60.0e6 / bpm); };
    auto tempoMeta = [usPerQ] (double bpm)
    {
        const int us = usPerQ (bpm);
        return juce::MidiMessage (0xFF, 0x51, 0x03,
                                  (us >> 16) & 0xFF, (us >> 8) & 0xFF, us & 0xFF);
    };
    juce::MidiFile mf;
    mf.setTicksPerQuarterNote (480);
    juce::MidiMessageSequence seq;
    seq.addEvent (tempoMeta (138.0));
    seq.addEvent (juce::MidiMessage::noteOn (1, 60, 0.8f), 0);
    seq.addEvent (juce::MidiMessage::noteOff (1, 60), 480);
    mf.addTrack (seq);

    juce::MemoryOutputStream mb;
    mf.writeTo (mb, 0);
    MidiFileIO::ImportResult r;
    CHECK (MidiFileIO::importMidiFromMemory (mb.getData(), mb.getDataSize(), r));
    CHECK (std::abs (r.tempoBpm - 138.0) < 0.5);
    CHECK (r.notes.size() == 1);

    // a file without any tempo meta defaults to 120
    juce::MidiFile mf2;
    mf2.setTicksPerQuarterNote (480);
    juce::MidiMessageSequence seq2;
    seq2.addEvent (juce::MidiMessage::noteOn (1, 60, 0.8f), 0);
    seq2.addEvent (juce::MidiMessage::noteOff (1, 60), 480);
    mf2.addTrack (seq2);
    juce::MemoryOutputStream mb2;
    mf2.writeTo (mb2, 0);
    MidiFileIO::ImportResult r2;
    CHECK (MidiFileIO::importMidiFromMemory (mb2.getData(), mb2.getDataSize(), r2));
    CHECK (std::abs (r2.tempoBpm - 120.0) < 0.01);
}

// Pause must freeze the cursor and silence everything; the file-tempo mode
// must advance the ppq cursor at fileBpm/projectBpm instead of 1:1.
static void testPreviewPauseAndRate()
{
    MidiClipDocument doc;
    Note n; n.pitch = 60; n.start = 0.0; n.length = 8.0;
    doc.beginTransaction ("p");
    doc.addNote (n);
    doc.commitTransaction();
    auto snap = doc.getSnapshot();
    DocumentSnapshot empty;
    PlaybackEngine eng;

    const auto renderBlocks = [&] (juce::MidiBuffer& out, int blocks, int samplesPerBlock)
    {
        for (int i = 0; i < blocks; ++i)
        {
            out.clear();
            EngineInputs in = makeInputs (empty, samplesPerBlock, false, 0.0, 0);
            in.previewSnapshot = snap.get();
            eng.render (out, in);
        }
    };

    // ---- pause freezes, resume continues ----------------------------------
    eng.setPreview (snap.get(), 8.0);
    juce::MidiBuffer out;
    renderBlocks (out, 2, 12000);                 // 1.0 ppq played
    const double posBefore = eng.previewPosForUi();
    CHECK (posBefore > 0.9 && posBefore < 1.1);

    eng.setPreviewPaused (true);
    out.clear();
    renderBlocks (out, 1, 12000);                 // first paused block: silence
    CHECK (countCc (out, 123) >= 1 && countCc (out, 120) >= 1);  // silenced
    renderBlocks (out, 3, 12000);                 // paused: cursor must hold
    CHECK (std::abs (eng.previewPosForUi() - posBefore) < 1e-6);

    eng.setPreviewPaused (false);
    renderBlocks (out, 1, 12000);
    CHECK (eng.previewPosForUi() > posBefore + 0.4);             // resumed

    // ---- file-tempo rate: 240bpm file at 120bpm host = 2x advance ---------
    eng.clearPreview();
    eng.setPreviewUseFileTempo (true);
    eng.setPreview (snap.get(), 64.0, 240.0);     // setPreview resets pause
    renderBlocks (out, 3, 12000);                 // 3 blocks = 1.5 ppq @1x
    const double posFast = eng.previewPosForUi();
    CHECK (posFast > 2.9 && posFast < 3.1);       // 2x → 3.0 ppq

    // project-tempo mode: back to 1x
    eng.setPreviewUseFileTempo (false);
    const double pos1x = eng.previewPosForUi();
    renderBlocks (out, 2, 12000);
    CHECK (std::abs (eng.previewPosForUi() - (pos1x + 1.0)) < 0.01);
}

static void testControllerAndPitchBend()
{
    MidiClipDocument doc;
    Note n; n.pitch = 60; n.start = 0.0; n.length = 1.0;
    ControllerEvent cc; cc.cc = 11; cc.ppq = 0.5; cc.value = 100;
    PitchBendEvent pb; pb.ppq = 1.0; pb.value = 10000;
    doc.beginTransaction ("expression");
    doc.addNote (n);
    doc.addCC (cc);
    doc.addPitchBend (pb);
    doc.commitTransaction();

    auto snap = doc.getSnapshot();
    CHECK (snap->notes.size() == 1);
    CHECK (snap->ccs.size() == 1 && snap->pbs.size() == 1);

    // one block covering ppq [0, 1.25) at 120 bpm (ppqPerSample = 1/24000)
    PlaybackEngine eng;
    juce::MidiBuffer out;
    eng.render (out, makeInputs (*snap, 30000, true, 0.0, 30000));

    int ccCount = 0, ccValue = -1, ccPos = -1;
    int pbCount = 0, pbValue = -1, pbPos = -1;
    for (const auto i : out)
    {
        const auto& m = i.getMessage();
        if (m.isController() && m.getControllerNumber() == 11)
        {
            ccCount++;
            ccValue = m.getControllerValue();
            ccPos = i.samplePosition;
        }
        if (m.isPitchWheel())
        {
            pbCount++;
            pbValue = m.getPitchWheelValue();
            pbPos = i.samplePosition;
        }
    }
    // Curves rest at neutral before the first knot (CC 0, PB center) and hold
    // the knot's value after it: one chase event + the knot event each.
    CHECK (ccCount == 2);
    CHECK (ccValue == 100);
    CHECK (ccPos == 12000);   // the knot lands exactly at 0.5 ppq
    CHECK (pbCount == 2);
    CHECK (pbValue == 10000); // 14-bit round trip
    CHECK (pbPos == 24000);   // 1.0 ppq in

    // undo removes the whole transaction (note + cc + pb)
    doc.undo();
    snap = doc.getSnapshot();
    CHECK (snap->notes.empty() && snap->ccs.empty() && snap->pbs.empty());
    doc.redo();
    snap = doc.getSnapshot();
    CHECK (snap->ccs.size() == 1 && snap->pbs.size() == 1);

    // event updates & removal
    auto updatedCc = snap->ccs[0];
    updatedCc.value = 40;
    doc.beginTransaction ("cc edit");
    doc.updateCCs ({ updatedCc });
    doc.commitTransaction();
    CHECK (doc.getSnapshot()->ccs[0].value == 40);
    doc.beginTransaction ("pb remove");
    doc.removePitchBends ({ snap->pbs[0].id });
    doc.commitTransaction();
    CHECK (doc.getSnapshot()->pbs.empty());
}

static void testDrumMapParse()
{
    DrumMapData data;

    // Ample Sound .bwdrm CSV: Name,SourceNote,SourceChannel,TargetNote,TargetChannel
    {
        const auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
                              .getChildFile ("PmeTests_test.bwdrm");
        temp.replaceWithText ("Kick1,60,0,36,10\r\nSnare,62,0,38,10\r\n\r\nBroken Line\n", false);
        CHECK (DrumMapIO::parse (temp, data));
        CHECK (data.entries.size() == 2); // one rule per source note
        CHECK (data.nameFor (60) == "Kick1");  // keyboard labels follow SOURCE key
        CHECK (data.nameFor (62) == "Snare");
        CHECK (data.nameFor (36).isEmpty());   // target pitch is not a label key
        // remap semantics: 60 → 36 on channel 10
        int outN = -1, outC = -1;
        CHECK (data.remap (60, 1, outN, outC));
        CHECK (outN == 36 && outC == 10);
        CHECK (! data.remap (40, 1, outN, outC));
        temp.deleteFile();
    }

    // Cubase .drm XML: INote -> ONote with Name
    {
        const auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
                              .getChildFile ("PmeTests_test.drm");
        temp.replaceWithText (
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n"
            "<DrumMap>\n"
            "  <list name=\"Map\" type=\"list\">\n"
            "    <item>\n"
            "      <int name=\"INote\" value=\"36\"/>\n"
            "      <int name=\"ONote\" value=\"36\"/>\n"
            "      <string name=\"Name\" value=\"Kick\" wide=\"true\"/>\n"
            "    </item>\n"
            "    <item>\n"
            "      <int name=\"INote\" value=\"38\"/>\n"
            "      <int name=\"ONote\" value=\"40\"/>\n"
            "      <string name=\"Name\" value=\"Snare\" wide=\"true\"/>\n"
            "    </item>\n"
            "  </list>\n"
            "</DrumMap>\n", false);
        CHECK (DrumMapIO::parse (temp, data));
        CHECK (data.entries.size() >= 2);
        CHECK (data.nameFor (36) == "Kick");
        CHECK (data.nameFor (40) == "Snare" || data.nameFor (38) == "Snare");
        temp.deleteFile();
    }

    // garbage rejected
    {
        const auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
                              .getChildFile ("PmeTests_bad.bwdrm");
        temp.replaceWithText ("no commas at all\n", false);
        CHECK (! DrumMapIO::parse (temp, data));
        temp.deleteFile();
    }
}

static void testSelectionSnapshot()
{
    MidiClipDocument doc;
    Note a; a.pitch = 60; a.start = 4.0; a.length = 0.5; a.lyric = "ni";
    Note b; b.pitch = 62; b.start = 4.5; b.length = 0.5; b.lyric = "hao";
    Note c; c.pitch = 64; c.start = 1.0; c.length = 0.5; // before the selection
    doc.beginTransaction ("s");
    const auto idA = doc.addNote (a);
    const auto idB = doc.addNote (b);
    doc.addNote (c);
    doc.commitTransaction();
    auto snap = doc.getSnapshot();

    bool ok = false;
    auto sel = makeSelectionSnapshot (*snap, { idA, idB }, ok);
    CHECK (ok);
    CHECK (sel.notes.size() == 2);
    CHECK (sel.ccs.empty() && sel.pbs.empty());
    // time normalized: first selected note starts at 0
    if (sel.notes.size() == 2)
    {
        CHECK (sel.notes[0].start == 0.0);
        CHECK (sel.notes[1].start == 0.5);
        CHECK (sel.notes[0].lyric == "ni");  // lyrics travel with the notes
        CHECK (sel.notes[1].lyric == "hao");
    }

    // unknown ids -> not ok
    sel = makeSelectionSnapshot (*snap, { 999 }, ok);
    CHECK (! ok);
}

static void testLyricRoundTrip()
{
    MidiClipDocument doc;
    Note a; a.pitch = 60; a.start = 0.0; a.length = 0.5; a.lyric = "ni";
    Note b; b.pitch = 62; b.start = 0.5; b.length = 0.5; b.lyric = "hao";
    Note c; c.pitch = 64; c.start = 1.0; c.length = 0.5; // no lyric
    doc.beginTransaction ("lyrics");
    doc.addNote (a);
    doc.addNote (b);
    doc.addNote (c);
    doc.commitTransaction();

    const auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
                          .getChildFile ("PmeTests_Lyrics.mid");
    CHECK (MidiFileIO::exportMidi (*doc.getSnapshot(), temp));

    // the exported file carries FF05 lyric meta at the tagged note-ons
    {
        juce::MidiFile mf;
        juce::FileInputStream in (temp);
        CHECK (mf.readFrom (in));
        int lyricCount = 0;
        bool sawNi = false, sawHao = false;
        for (int tr = 0; tr < mf.getNumTracks(); ++tr)
            for (int i = 0; i < mf.getTrack (tr)->getNumEvents(); ++i)
            {
                const auto& m = mf.getTrack (tr)->getEventPointer (i)->message;
                if (m.isMetaEvent() && m.getMetaEventType() == 0x05)
                {
                    ++lyricCount;
                    const auto text = m.getTextFromTextMetaEvent();
                    if (text == "ni") sawNi = true;
                    if (text == "hao") sawHao = true;
                }
            }
        CHECK (lyricCount == 2);
        CHECK (sawNi && sawHao);
    }

    // import re-attaches lyrics to the right notes; untagged note stays empty
    MidiFileIO::ImportResult imported;
    CHECK (MidiFileIO::importMidi (temp, imported));
    CHECK (imported.notes.size() == 3);
    for (const auto& n : imported.notes)
    {
        if (n.pitch == 60) CHECK (n.lyric == "ni");
        if (n.pitch == 62) CHECK (n.lyric == "hao");
        if (n.pitch == 64) CHECK (n.lyric.isEmpty());
    }
    temp.deleteFile();
}

static void testExpressionMapImport()
{
    // Ample Sound .exprmap text format: "Name,Keyswitch" lines (CRLF ok)
    const auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
                          .getChildFile ("PmeTests_ample.exprmap");
    temp.replaceWithText ("Sustain,24\r\nPizzicato,27\r\nFX Hit,93\r\n", false);

    auto arts = ExpressionMapIO::parse (temp);
    CHECK (arts.size() == 3);
    if (arts.size() == 3)
    {
        CHECK (arts[0].name == "Sustain" && arts[0].keyswitch == 24);
        CHECK (arts[1].name == "Pizzicato" && arts[1].keyswitch == 27);
        CHECK (arts[2].name == "FX Hit" && arts[2].keyswitch == 93);
        CHECK (arts[0].cc == -1);
    }

    // names containing commas keep everything up to the LAST comma as the name
    temp.replaceWithText ("Slide In, Extra,44\r\n", false);
    arts = ExpressionMapIO::parse (temp);
    CHECK (arts.size() == 1);
    if (arts.size() == 1)
    {
        CHECK (arts[0].keyswitch == 44);
        CHECK (arts[0].name.contains ("Slide In"));
    }

    // garbage is rejected (empty result)
    temp.replaceWithText ("this is not a map\nno commas here\n", false);
    CHECK (ExpressionMapIO::parse (temp).empty());

    // the user's real map, when present, must parse to a non-empty set with
    // valid keyswitch ranges
    const juce::File realMap ("D:/LocalProject/expmap/ample_china_erhu.exprmap");
    if (realMap.existsAsFile())
    {
        auto real = ExpressionMapIO::parse (realMap);
        CHECK (real.size() >= 20);
        bool allValid = true;
        for (const auto& a : real)
            if (a.keyswitch < 0 || a.keyswitch > 127 || a.name.isEmpty())
                allValid = false;
        CHECK (allValid);
    }

    temp.deleteFile();
}

static void testInternalTransport()
{
    MidiClipDocument doc;
    Note a; a.pitch = 60; a.start = 0.0; a.length = 0.5;
    Note b; b.pitch = 67; b.start = 2.0; b.length = 0.5;
    PitchBendEvent pb; pb.ppq = 0.25; pb.value = 10000;
    doc.beginTransaction ("t");
    doc.addNote (a);
    doc.addNote (b);
    doc.addPitchBend (pb);
    doc.commitTransaction();
    auto snap = doc.getSnapshot();

    PlaybackEngine eng;
    juce::MidiBuffer out;

    // start from the second note: it fires immediately, the first does not;
    // content bounds are [0, 3.0) so this block ends exactly on the loop end
    // and the wrap flushes note 67's note-off
    eng.startInternal (2.0);
    eng.render (out, makeInputs (*snap, 24000, false, 0.0, 0)); // host stopped
    CHECK (countOn (out, 67) == 1);
    CHECK (countOn (out, 60) == 0);
    CHECK (countOff (out, 67) == 1);
    CHECK (eng.isInternalPlayingForUi());

    // second block restarts from the loop start: note 60 fires, bend chases
    out.clear();
    eng.render (out, makeInputs (*snap, 24000, false, 0.0, 24000));
    CHECK (countOn (out, 60) == 1);

    // stop: the still-held note 60 gets its note-off and the bend (left at
    // the knot value 10000) returns to center
    eng.stopInternal();
    out.clear();
    eng.render (out, makeInputs (*snap, 12000, false, 0.0, 72000));
    CHECK (! eng.isInternalPlayingForUi());
    CHECK (countOn (out, 60) == 0);
    CHECK (countOff (out, 60) == 1);
    int pbAfterStop = -1;
    for (const auto i : out)
        if (i.getMessage().isPitchWheel())
            pbAfterStop = i.getMessage().getPitchWheelValue();
    CHECK (pbAfterStop == 8192);

    // host transport STOPS while internal transport runs: the whole plugin
    // must go silent (this was the "DAW stops, plugin keeps playing" bug)
    {
        PlaybackEngine eng2;
        juce::MidiBuffer out2;
        eng2.startInternal (0.0);
        eng2.render (out2, makeInputs (*snap, 12000, false, 0.0, 0)); // host stopped
        CHECK (countOn (out2, 60) == 1);
        CHECK (eng2.isInternalPlayingForUi());

        // host then STARTS playing -> internal must hand over silently
        out2.clear();
        eng2.render (out2, makeInputs (*snap, 12000, true, 0.5, 12000));
        CHECK (! eng2.isInternalPlayingForUi());

        // host then STOPS -> nothing left sounding from either path
        out2.clear();
        eng2.render (out2, makeInputs (*snap, 12000, false, 1.0, 24000));
        CHECK (! eng2.isInternalPlayingForUi());
    }

    // host transport playing takes over: internal play stops by itself
    eng.startInternal (0.0);
    out.clear();
    eng.render (out, makeInputs (*snap, 12000, true, 0.0, 96000));
    CHECK (! eng.isInternalPlayingForUi());
    CHECK (countOn (out, 60) == 1); // the note fires once — from the HOST path
}

static void testCurveInterpolation()
{
    MidiClipDocument doc;
    // A ramp 8192 -> 12288 over [0, 1) ppq: playback must produce a continuous
    // rise, not two disconnected jumps.
    PitchBendEvent a; a.ppq = 0.0; a.value = 8192;
    PitchBendEvent b; b.ppq = 1.0; b.value = 12288;
    ControllerEvent c1; c1.cc = 11; c1.ppq = 0.25; c1.value = 0;
    ControllerEvent c2; c2.cc = 11; c2.ppq = 0.75; c2.value = 127;
    doc.beginTransaction ("curve");
    doc.addPitchBend (a);
    doc.addPitchBend (b);
    doc.addCC (c1);
    doc.addCC (c2);
    doc.commitTransaction();
    auto snap = doc.getSnapshot();

    PlaybackEngine eng;
    juce::MidiBuffer out;
    eng.render (out, makeInputs (*snap, 36000, true, 0.0, 0)); // [0, 1.5) ppq

    std::vector<std::pair<int, int>> pbSeries; // (value, sampleOffset)
    std::vector<std::pair<int, int>> ccSeries;
    for (const auto i : out)
    {
        const auto& m = i.getMessage();
        if (m.isPitchWheel())
            pbSeries.emplace_back (m.getPitchWheelValue(), (int) i.samplePosition);
        if (m.isController() && m.getControllerNumber() == 11)
            ccSeries.emplace_back (m.getControllerValue(), (int) i.samplePosition);
    }

    // pitch bend ramps from 8192 up to 12288 and holds
    CHECK (pbSeries.size() >= 8);
    if (! pbSeries.empty())
    {
        CHECK (pbSeries.front().first == 8192);
        CHECK (pbSeries.back().first == 12288);
        bool strictlyRising = true;
        for (size_t i = 1; i < pbSeries.size(); ++i)
            if (pbSeries[i].first < pbSeries[i - 1].first)
                strictlyRising = false;
        CHECK (strictlyRising);
        // the midpoint of the ramp is close to the interpolated value
        CHECK (pbSeries[pbSeries.size() / 2].first > 9216);
        CHECK (pbSeries[pbSeries.size() / 2].first < 11264);
    }

    // CC11 ramps 0 -> 127 between 0.25 and 0.75 ppq
    CHECK (ccSeries.size() >= 8);
    if (! ccSeries.empty())
    {
        CHECK (ccSeries.front().first == 0);
        CHECK (ccSeries.back().first == 127);
        bool strictlyRising = true;
        for (size_t i = 1; i < ccSeries.size(); ++i)
            if (ccSeries[i].first < ccSeries[i - 1].first)
                strictlyRising = false;
        CHECK (strictlyRising);
    }

    // a second block continues the hold without re-sending unchanged values
    out.clear();
    eng.render (out, makeInputs (*snap, 12000, true, 1.5, 36000));
    int pbRe = 0, ccRe = 0;
    for (const auto i : out)
    {
        if (i.getMessage().isPitchWheel()) ++pbRe;
        if (i.getMessage().isController() && i.getMessage().getControllerNumber() == 11) ++ccRe;
    }
    CHECK (pbRe == 0);
    CHECK (ccRe == 0);
}

static void testChordsAndArticulations()
{
    MidiClipDocument doc;

    // -- chord CRUD + undo --
    ChordEvent c; c.start = 0.0; c.length = 4.0; c.root = 2; c.quality = 5;
    doc.beginTransaction ("chord");
    doc.addChord (c);
    doc.commitTransaction();
    CHECK (doc.getSnapshot()->chords.size() == 1);
    doc.undo();
    CHECK (doc.getSnapshot()->chords.empty());
    doc.redo();
    CHECK (doc.getSnapshot()->chords.size() == 1);

    auto updated = doc.getSnapshot()->chords[0];
    updated.root = 7;
    doc.beginTransaction ("chord edit");
    doc.updateChords ({ updated });
    doc.commitTransaction();
    CHECK (doc.getSnapshot()->chords[0].root == 7);
    doc.clear();
    CHECK (doc.getSnapshot()->chords.empty());

    // -- articulation injection on output --
    Note n; n.pitch = 60; n.start = 0.25; n.length = 0.25;
    n.art = 77; // articulation id
    ArticulationDef art;
    art.id = 77;
    art.keyswitch = 24; // C0 keyswitch
    art.cc = -1;
    doc.setArticulations ({ art });
    doc.beginTransaction ("t");
    doc.addNote (n);
    doc.commitTransaction();
    CHECK (doc.getSnapshot()->articulations.size() == 1);

    PlaybackEngine eng;
    juce::MidiBuffer out;
    // one block covering ppq [0, 0.5) at 120 bpm (12000 samples)
    eng.render (out, makeInputs (*doc.getSnapshot(), 12000, true, 0.0, 12000));

    int ksOn = 0, ksOnOffset = -1, mainOn = 0, mainOnOffset = -1;
    for (const auto& ev : out)
    {
        const auto& m = ev.getMessage();
        if (m.isNoteOn() && m.getNoteNumber() == 24)
        {
            ++ksOn;
            ksOnOffset = ev.samplePosition;
        }
        if (m.isNoteOn() && m.getNoteNumber() == 60)
        {
            ++mainOn;
            mainOnOffset = ev.samplePosition;
        }
    }
    CHECK (ksOn == 1);
    CHECK (mainOn == 1);
    CHECK (ksOnOffset <= mainOnOffset); // keyswitch injected before (or with) the note

    // same articulation again -> no repeated keyswitch
    out.clear();
    eng.render (out, makeInputs (*doc.getSnapshot(), 12000, true, 0.5, 24000));
    ksOn = 0;
    for (const auto& ev : out)
        if (ev.getMessage().isNoteOn() && ev.getMessage().getNoteNumber() == 24)
            ++ksOn;
    CHECK (ksOn == 0);
}

static void testMidiMemoryImport()
{
    MidiClipDocument doc;
    Note n; n.pitch = 64; n.start = 0.25; n.length = 0.5; n.velocity = 0.9f; n.art = 7;
    ControllerEvent cc; cc.cc = 11; cc.ppq = 0.5; cc.value = 100;
    PitchBendEvent pb; pb.ppq = 1.0; pb.value = 10000;
    ArticulationDef art; art.id = 7; art.name = "Staccato"; art.keyswitch = 24; art.cc = 12; art.ccValue = 90;
    doc.setArticulations ({ art });
    doc.beginTransaction ("io");
    doc.addNote (n);
    doc.addCC (cc);
    doc.addPitchBend (pb);
    doc.commitTransaction();

    const auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
                          .getChildFile ("PmeTests_MemImport.mid");
    const auto snap = doc.getSnapshot();
    CHECK (MidiFileIO::exportMidi (*snap, temp));

    juce::FileInputStream in (temp);
    CHECK (in.openedOk());
    juce::MemoryBlock bytes;
    in.readIntoMemoryBlock (bytes);

    MidiFileIO::ImportResult imported;
    CHECK (MidiFileIO::importMidiFromMemory (bytes.getData(), (size_t) bytes.getSize(), imported));
    // baked ramps: one neutral chase event + the knot per curve; the
    // articulation materializes as a short keyswitch note (pitch 24) ahead of
    // the tagged note, so the round trip sees 2 notes
    CHECK (imported.notes.size() == 2);
    CHECK (imported.ccs.size() == 3 && imported.pbs.size() == 2);
    {
        bool sawTagged = false, sawKs = false;
        for (const auto& in2 : imported.notes)
        {
            if (in2.pitch == 64) sawTagged = true;
            if (in2.pitch == 24) sawKs = true;
        }
        CHECK (sawTagged && sawKs);
    }
    if (imported.pbs.size() == 2)
    {
        CHECK (imported.pbs[0].value == 8192);  // center rest baked at tick 0
        CHECK (imported.pbs[1].value == 10000);
    }

    // articulation CC (12 = 90) must also be baked into the file
    {
        juce::MidiFile mf;
        juce::FileInputStream in2 (temp);
        CHECK (mf.readFrom (in2));
        bool sawKsOn = false, sawCc12 = false;
        for (int tr = 0; tr < mf.getNumTracks(); ++tr)
            for (int i = 0; i < mf.getTrack (tr)->getNumEvents(); ++i)
            {
                const auto& m = mf.getTrack (tr)->getEventPointer (i)->message;
                if (m.isNoteOn() && m.getNoteNumber() == 24) sawKsOn = true;
                if (m.isController() && m.getControllerNumber() == 12 && m.getControllerValue() == 90) sawCc12 = true;
            }
        CHECK (sawKsOn);
        CHECK (sawCc12);
    }

    // garbage and empty input must fail cleanly (drag-in of a non-MIDI file)
    MidiFileIO::ImportResult bad;
    CHECK (! MidiFileIO::importMidiFromMemory (bytes.getData(), 0, bad));
    const char junk[] = "this is definitely not a midi file, just text";
    CHECK (! MidiFileIO::importMidiFromMemory (junk, sizeof (junk) - 1, bad));

    temp.deleteFile();
}

//==============================================================================
// Live recording must capture the ACTUAL held duration: the note-off time
// determines the length (this was once hardcoded to one grid cell).
static void testRecordedNotePairing()
{
    // free mode: length = note-off time - note-on time
    {
        std::vector<RecEvent> ev = {
            { true, 60, 1, 0.9f, 1.02 }, { false, 60, 1, 0.0f, 2.37 },
        };
        std::map<int, std::pair<double, float>> pending;
        const auto notes = notesFromRecordedEvents (ev, false, 0.25, pending);
        CHECK (notes.size() == 1);
        if (notes.size() == 1)
        {
            CHECK (std::abs (notes[0].start - 1.02) < 1e-9);
            CHECK (std::abs (notes[0].length - 1.35) < 1e-9);
            CHECK (std::abs (notes[0].velocity - 0.9f) < 1e-6f);
            CHECK (notes[0].channel == 1);
        }
    }

    // quantized mode: start floors to the grid, end snaps to the nearest line
    {
        std::vector<RecEvent> ev = {
            { true, 60, 1, 0.9f, 1.02 }, { false, 60, 1, 0.0f, 2.90 },
        };
        std::map<int, std::pair<double, float>> pending;
        const auto notes = notesFromRecordedEvents (ev, true, 0.25, pending);
        CHECK (notes.size() == 1);
        if (notes.size() == 1)
        {
            CHECK (std::abs (notes[0].start - 1.0) < 1e-9);
            CHECK (std::abs (notes[0].length - 2.0) < 1e-9); // end 2.9 -> 3.0
        }
    }

    // very short tap still yields one full grid cell
    {
        std::vector<RecEvent> ev = {
            { true, 62, 1, 0.8f, 2.0 }, { false, 62, 1, 0.0f, 2.05 },
        };
        std::map<int, std::pair<double, float>> pending;
        const auto notes = notesFromRecordedEvents (ev, false, 0.25, pending);
        CHECK (notes.size() == 1);
        if (notes.size() == 1)
            CHECK (std::abs (notes[0].length - 0.25) < 1e-9);
    }

    // held chord: each pitch pairs with its own note-off independently
    {
        std::vector<RecEvent> ev = {
            { true, 60, 1, 0.9f, 0.0 }, { true, 64, 1, 0.9f, 0.0 },
            { false, 64, 1, 0.0f, 1.5 }, { false, 60, 1, 0.0f, 2.0 },
        };
        std::map<int, std::pair<double, float>> pending;
        const auto notes = notesFromRecordedEvents (ev, false, 0.25, pending);
        CHECK (notes.size() == 2);
        for (const auto& n : notes)
            CHECK (std::abs (n.length - (n.pitch == 60 ? 2.0 : 1.5)) < 1e-9);
    }

    // the drain timer splits a held note across batches: the note-on must
    // survive in `pending` until a LATER call delivers the note-off
    {
        std::map<int, std::pair<double, float>> pending;
        auto first = notesFromRecordedEvents (
            { { true, 60, 1, 0.9f, 1.0 } }, false, 0.25, pending);
        CHECK (first.empty());
        auto second = notesFromRecordedEvents (
            { { false, 60, 1, 0.0f, 3.75 } }, false, 0.25, pending);
        CHECK (second.size() == 1);
        if (second.size() == 1)
        {
            CHECK (std::abs (second[0].start - 1.0) < 1e-9);
            CHECK (std::abs (second[0].length - 2.75) < 1e-9);
        }
    }

    // an unmatched note-off is ignored
    {
        std::vector<RecEvent> ev = { { false, 60, 1, 0.0f, 1.0 } };
        std::map<int, std::pair<double, float>> pending;
        CHECK (notesFromRecordedEvents (ev, false, 0.25, pending).empty());
    }
}

//==============================================================================
// Cross-instance chord-track sharing: two handles on the same named segment
// round-trip chords, and setChordsExternal applies them without undo.
static void testSharedChordTrack()
{
    SharedChordTrack a, b;
    std::cout << "  shm a.valid=" << a.valid() << " (err=" << a.openError() << ")"
              << " b.valid=" << b.valid() << " (err=" << b.openError() << ")" << std::endl;
    CHECK (a.valid() && b.valid());

    uint32_t v = 0;

    // round-trip: publish a chord list from A, read it from B
    const juce::String json = "[{\"s\":0,\"l\":4,\"r\":0,\"q\":1},{\"s\":4,\"l\":2,\"r\":9,\"q\":0}]";
    CHECK (a.publish (json, v));
    CHECK (b.currentVersion() >= v);
    juce::String fetched;
    CHECK (b.fetch (fetched));
    CHECK (fetched == json);

    // second publish bumps the version
    uint32_t v2 = 0;
    CHECK (a.publish ("[]", v2));
    CHECK (v2 > v);

    // setChordsExternal: applies immediately, not undoable, fresh ids
    MidiClipDocument doc;
    std::vector<ChordEvent> chords;
    for (const int q : { 0, 1 })
    {
        ChordEvent c;
        c.id = (juce::uint32) (q + 1);
        c.start = 4.0 * q;
        c.length = 4.0;
        c.root = q == 0 ? 0 : 9;
        c.quality = q;
        chords.push_back (c);
    }
    const auto revBefore = doc.getRevision();
    doc.setChordsExternal (chords);
    auto snap = doc.getSnapshot();
    CHECK (snap->chords.size() == 2);
    CHECK (snap->chords[0].id != snap->chords[1].id);
    CHECK (doc.getRevision() > revBefore);
    CHECK (! doc.canUndo()); // external sync must not enter the undo stack
}

int main()
{
    testDocumentUndoRedo();
    testDocumentJson();
    testEngineScheduling();
    testEngineLoopWrap();
    testAudition();
    testPreviewAndPanic();
    testPreviewSwitchStopsSound();
    testImportTempo();
    testChordAnalyzer();
    testChordAnalyzerExtended();
    testChordAnalyzerMidBarChange();
    testImportTicksPerQuarter();
    testPreviewPauseAndRate();
    testControllerAndPitchBend();
    testCurveInterpolation();
    testRecordedNotePairing();
    testSharedChordTrack();
    testInternalTransport();
    testExpressionMapImport();
    testLyricRoundTrip();
    testSelectionSnapshot();
    testDrumMapParse();
    testChordsAndArticulations();
    testMidiMemoryImport();

    if (failures == 0)
    {
        std::cout << "PmeTests: all tests passed\n";
        return 0;
    }
    std::cout << "PmeTests: " << failures << " failure(s)\n";
    return 1;
}
