// Console unit tests for the document model and the playback engine.
// Run via: ctest or directly (returns non-zero on failure).
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include "../Source/Model/MidiClipDocument.h"
#include "../Source/Playback/PlaybackEngine.h"
#include "../Source/FileIO/MidiFileIO.h"
#include "../Source/FileIO/ExpressionMapIO.h"
#include "../Source/FileIO/DrumMapIO.h"

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
        CHECK (data.entries.size() == 4); // Kick1 (60+36), Snare (62+38)
        CHECK (data.nameFor (60) == "Kick1");
        CHECK (data.nameFor (36) == "Kick1");
        CHECK (data.nameFor (62) == "Snare");
        CHECK (data.nameFor (38) == "Snare");
        CHECK (data.nameFor (40).isEmpty());
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

int main()
{
    testDocumentUndoRedo();
    testDocumentJson();
    testEngineScheduling();
    testEngineLoopWrap();
    testAudition();
    testPreviewAndPanic();
    testControllerAndPitchBend();
    testCurveInterpolation();
    testInternalTransport();
    testExpressionMapImport();
    testLyricRoundTrip();
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
