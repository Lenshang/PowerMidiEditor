#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include "../Model/MidiClipDocument.h"

namespace pme
{

// Inputs gathered by the processor from the host for one processBlock call.
struct EngineInputs
{
    const DocumentSnapshot* snapshot = nullptr;
    int numSamples = 0;
    double sampleRate = 48000.0;

    bool playing = false;
    bool ppqValid = false;
    double ppq = 0.0;                 // position at block start
    double tempo = 120.0;             // bpm
    bool timeValid = false;
    juce::int64 timeInSamples = 0;

    bool loopValid = false;           // host loop points + looping enabled
    double loopStartPpq = 0.0;
    double loopEndPpq = 0.0;

    // MIDI browser preview: when set, the engine loops this snapshot instead
    // of the main document (independent of the host transport).
    const DocumentSnapshot* previewSnapshot = nullptr;
};

// Schedules the document's notes against the host transport, entirely on the
// audio thread. render() is real-time safe: no allocations except small
// vector growth of the (bounded) active-note lists, no locks.
//
// Controls from the message thread go through a lock-free SPSC command queue:
//   startAudition / stopAudition / previewNote / panic
class PlaybackEngine
{
public:
    PlaybackEngine();

    void render (juce::MidiBuffer& out, const EngineInputs& in);

    // -- message thread controls -------------------------------------------
    void startAudition (double startPpq);  // audition tool: play from position
    void stopAudition();
    void previewNote (int pitch, int channel, float velocity); // short one-shot
    void panic();                          // all notes off immediately
    // plugin's own play button: loops the pattern independent of the host
    void startInternal (double startPpq);
    void stopInternal();
    bool isInternalPlayingForUi() const { return internalFlagForUi.load (std::memory_order_relaxed); }
    double internalCursorForUi() const { return internalPpqForUi.load (std::memory_order_relaxed); }

    // MIDI browser preview: loop a parsed file snapshot without touching the
    // document. Length = musical span of the file; loops until cleared.
    void setPreview (const DocumentSnapshot* snap, double lengthPpq);
    void clearPreview();
    bool isPreviewingForUi() const { return previewActive.load (std::memory_order_relaxed); }

    bool isAuditioningForUi() const { return auditionFlagForUi.load (std::memory_order_relaxed); }
    double auditionCursorForUi() const { return auditionPpqForUi.load (std::memory_order_relaxed); }

private:
    enum class CmdType { auditionStart, auditionStop, previewNote, panic, internalPlay, internalStop };
    struct Cmd
    {
        CmdType type {};
        double ppq = 0.0;
        int pitch = 0, channel = 1;
        float velocity = 0.8f;
    };

    // Minimal SPSC ring (message thread producer, audio thread consumer).
    static constexpr int cmdCapacity = 64;
    std::atomic<int> cmdRead { 0 };
    std::atomic<int> cmdWrite { 0 };
    Cmd cmdRing[cmdCapacity];
    bool pushCmd (const Cmd& c);   // message thread
    void drainCmds();              // audio thread

    struct ActiveNote
    {
        juce::uint32 id;
        int pitch, channel;
        double endPpq;             // in the timeline the cursor belongs to
    };
    struct PreviewNote
    {
        int pitch, channel;
        juce::int64 endSample;     // engine-absolute sample index
        float velocity = 0.8f;
    };

    // audio-thread state
    std::vector<ActiveNote> activeNotes;     // transport-driven
    std::vector<ActiveNote> auditionNotes;   // audition-driven
    std::vector<ActiveNote> internalNotes;   // internal play button
    std::vector<PreviewNote> previews;
    std::vector<PreviewNote> previewNoteOns; // queued immediate note-ons
    int currentArt[16];                      // last articulation id per channel
    bool internalPlaying = false;            // internal transport running
    bool internalStarted = false;            // next render is its first block
    bool internalStopRequested = false;      // flush pending notes in render()
    bool auditionStopRequested = false;      // flush sounding notes in render()
    double internalCursor = 0.0;
    // curve state: CC/PB lanes render as linear ramps between points; these
    // hold the last value sent per curve so identical values are not re-sent
    int lastPbSent[16];
    int lastCcSent[16][128];
    std::vector<double> tickScratch;         // per-block sample times (reused, no allocs steady-state)
    std::vector<uint8_t> ccHasPrev, ccHasNext;
    std::vector<double> ccPrevT, ccNextT;
    std::vector<int> ccPrevV, ccNextV;
    double cursor = 0.0;                     // transport cursor (ppq)
    double auditionCursor = 0.0;
    bool auditionActive = false;
    double currentSampleRate = 48000.0;
    bool panicRequested = false;
    bool wasPlaying = false;
    bool cursorValid = false;
    juce::int64 lastTimeInSamples = 0;
    bool lastTimeValid = false;
    int lastNumSamples = 0;
    double lastPpqPerSample = 0.0;
    juce::int64 engineSampleCounter = 0;

    std::atomic<bool> auditionFlagForUi { false };
    std::atomic<bool> internalFlagForUi { false };
    std::atomic<double> internalPpqForUi { 0.0 };
    std::atomic<double> auditionPpqForUi { 0.0 };

    // file preview (midi browser) state — audio thread only
    std::atomic<bool> previewActive { false };
    bool previewRestart = false;
    bool previewWasActive = false;
    double previewCursor = 0.0;
    double previewLen = 1.0;
    std::vector<ActiveNote> previewNotes;

    void flushNotes (juce::MidiBuffer& out, std::vector<ActiveNote>& list, int sampleOffset);
    void playRange (juce::MidiBuffer& out, const EngineInputs& in,
                    double fromPpq, double toPpq, double anchorPpq, int blockStartSample,
                    std::vector<ActiveNote>& active, bool chase);
    void resetCurveState() noexcept;
    // Sends the neutral value (PB center, CC 0) for every curve that moved —
    // called when playback stops so instruments don't hold a bend/expression.
    void resetCurvesToNeutral (juce::MidiBuffer& out);
    // Samples the CC/PB piecewise-linear curves over [fromPpq, toPpq) and emits
    // events wherever a curve's rounded value changes (chase: the value at the
    // segment start is sent immediately).
    void playCurves (juce::MidiBuffer& out, const EngineInputs& in,
                     double fromPpq, double toPpq, double anchorPpq, int blockStartSample);
    int sampleOffsetFor (double ppq, double anchorPpq, const EngineInputs& in) const;

    JUCE_DECLARE_NON_COPYABLE (PlaybackEngine)
};

} // namespace pme
