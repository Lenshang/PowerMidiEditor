#pragma once

#include <juce_core/juce_core.h>

namespace pme
{

// One MIDI note. Times are in quarter notes (PPQ where 1.0 = one quarter),
// independent of the host's ticks-per-quarter resolution.
struct Note
{
    juce::uint32 id = 0;
    int pitch = 60;        // 0..127
    double start = 0.0;    // quarter notes
    double length = 0.25;  // quarter notes
    float velocity = 0.8f; // 0..1
    bool muted = false;
    int channel = 1;       // 1..16
    int art = -1;          // expression articulation id (see ArticulationDef), -1 = none

    bool operator== (const Note& o) const
    {
        return id == o.id && pitch == o.pitch && start == o.start && length == o.length
            && velocity == o.velocity && muted == o.muted && channel == o.channel && art == o.art;
    }
};

// One CC controller event (expression, modulation, sustain, ...).
struct ControllerEvent
{
    juce::uint32 id = 0;
    int cc = 11;         // controller number 0..127
    int channel = 1;     // 1..16
    double ppq = 0.0;    // quarter notes
    int value = 0;       // 0..127

    bool operator== (const ControllerEvent& o) const
    {
        return id == o.id && cc == o.cc && channel == o.channel && ppq == o.ppq && value == o.value;
    }
};

// One pitch-bend event. value 0..16383 with 8192 = center.
struct PitchBendEvent
{
    juce::uint32 id = 0;
    int channel = 1;     // 1..16
    double ppq = 0.0;
    int value = 8192;

    bool operator== (const PitchBendEvent& o) const
    {
        return id == o.id && channel == o.channel && ppq == o.ppq && value == o.value;
    }
};

// Expression-map articulation: a named playing style that can inject a
// keyswitch note and/or a CC value before notes tagged with it.
struct ArticulationDef
{
    juce::uint32 id = 0;
    juce::String name;
    int keyswitch = -1;  // keyswitch pitch 0..127, -1 = none
    int cc = -1;         // cc number 0..127, -1 = none
    int ccValue = 0;     // 0..127
};

// One chord-track event (guidance + optional highlight; not played back).
struct ChordEvent
{
    juce::uint32 id = 0;
    double start = 0.0;   // quarter notes
    double length = 1.0;  // quarter notes
    int root = 0;         // pitch class 0..11 (0 = C)
    int quality = 0;      // index into chordQualities() in the UI

    bool operator== (const ChordEvent& o) const
    {
        return id == o.id && start == o.start && length == o.length
            && root == o.root && quality == o.quality;
    }
};

// Immutable view of the document handed to the audio thread and to the UI.
struct DocumentSnapshot
{
    std::vector<Note> notes;             // sorted by (start, id)
    std::vector<ControllerEvent> ccs;    // sorted by (ppq, id)
    std::vector<PitchBendEvent> pbs;     // sorted by (ppq, id)
    std::vector<ChordEvent> chords;      // sorted by (start, id)
    std::vector<ArticulationDef> articulations;
    juce::uint64 revision = 0;

    const Note* findNote (juce::uint32 id) const;
    const ArticulationDef* findArticulation (juce::uint32 id) const;
    const ControllerEvent* findCc (juce::uint32 id) const;
    const PitchBendEvent* findPb (juce::uint32 id) const;
    const ChordEvent* findChord (juce::uint32 id) const;
};

// Undoable, snapshot-publishing MIDI clip document (notes, CC, pitch bend).
// All mutations happen on the message thread; the audio thread only ever
// reads the latest published snapshot through an atomic shared_ptr.
class MidiClipDocument
{
public:
    MidiClipDocument() = default;

    std::shared_ptr<const DocumentSnapshot> getSnapshot() const
    {
        const juce::SpinLock::ScopedLockType sl (snapshotLock);
        return snapshot;
    }
    juce::uint64 getRevision() const
    {
        const juce::SpinLock::ScopedLockType sl (snapshotLock);
        return snapshot->revision;
    }

    // -- mutations (message thread only) -----------------------------------
    void beginTransaction (juce::String name);
    void commitTransaction();
    void cancelTransaction();

    juce::uint32 addNote (Note n);                        // assigns a fresh id, returns it
    void updateNotes (const std::vector<Note>& updated);  // matched by id
    void removeNotes (const std::vector<juce::uint32>& ids);

    juce::uint32 addCC (ControllerEvent e);
    void updateCCs (const std::vector<ControllerEvent>& updated);
    void removeCCs (const std::vector<juce::uint32>& ids);

    juce::uint32 addPitchBend (PitchBendEvent e);
    void updatePitchBends (const std::vector<PitchBendEvent>& updated);
    void removePitchBends (const std::vector<juce::uint32>& ids);

    juce::uint32 addChord (ChordEvent e);
    void updateChords (const std::vector<ChordEvent>& updated);
    void removeChords (const std::vector<juce::uint32>& ids);

    // Expression map (message thread; not undoable — published immediately).
    void setArticulations (const std::vector<ArticulationDef>& arts);
    const std::vector<ArticulationDef>& getArticulations() const { return articulations; }

    void undo();
    void redo();
    bool canUndo() const { return undoIndex > 0; }
    bool canRedo() const { return undoIndex < transactions.size(); }

    void clear();

    // -- persistence --------------------------------------------------------
    juce::var toVar() const;
    void loadFromVar (const juce::var& v);
    static juce::var snapshotToJson (const DocumentSnapshot& s);

    // Called (message thread) after any committed change.
    std::function<void()> onDocumentChanged;

private:
    struct Op
    {
        enum class Kind { add, remove, update };
        enum class Type { note, cc, pb, chord };
        Kind kind = Kind::add;
        Type type = Type::note;
        Note noteBefore, noteAfter;
        ControllerEvent ccBefore, ccAfter;
        PitchBendEvent pbBefore, pbAfter;
        ChordEvent chordBefore, chordAfter;
    };

    void apply (const Op& op, bool forward);
    void record (Op op);
    void publish();

    std::map<juce::uint32, Note> notes;
    std::map<juce::uint32, ControllerEvent> ccs;
    std::map<juce::uint32, PitchBendEvent> pbs;
    std::map<juce::uint32, ChordEvent> chords;
    std::vector<ArticulationDef> articulations;
    juce::uint32 nextId = 1; // shared across all event types

    std::vector<std::vector<Op>> transactions; // committed undo entries
    std::vector<Op> pendingTransaction;
    size_t undoIndex = 0;

    // Cross-platform snapshot slot: std::atomic<shared_ptr> is unavailable in
    // AppleClang libc++, so guard a plain shared_ptr with a spinlock. Writers
    // are rare (message-thread edits); readers only copy the pointer.
    mutable juce::SpinLock snapshotLock;
    std::shared_ptr<const DocumentSnapshot> snapshot { std::make_shared<const DocumentSnapshot>() };

    JUCE_DECLARE_NON_COPYABLE (MidiClipDocument)
};

} // namespace pme
