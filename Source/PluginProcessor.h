#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include "Model/MidiClipDocument.h"
#include "FileIO/DrumMapIO.h"
#include "Playback/PlaybackEngine.h"
#include "PluginSettings.h"

namespace pme
{

//==============================================================================
class PowerMidiEditorAudioProcessor : public juce::AudioProcessor
{
public:
    PowerMidiEditorAudioProcessor();
    ~PowerMidiEditorAudioProcessor() override = default;

    //==================================================================
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    //==================================================================
    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }
    const juce::String getName() const override { return JucePlugin_Name; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return true; }
    bool isMidiEffect() const override { return PME_MIDI_ONLY != 0; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return {}; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    //==================================================================
    // UI / bridge access (message thread)
    MidiClipDocument document;
    PluginSettings settings;
    std::atomic<juce::uint64> settingsRevision { 1 };

    void updateSettingsFromUi (const juce::var& v);

    // user-level UI preferences (theme / language / shortcuts / snap bypass):
    // stored in a shared per-user file so every NEW instance inherits them,
    // unlike the plugin state which is per project / per instance.
    static juce::File uiPrefsFile();
    void saveUiPrefs() const;
    void loadUiPrefs();
    PlaybackEngine& getEngine() { return engine; }

    // Set when the WebView UI completed its init RPC (used by the automated
    // host test to assert the bridge is alive without screenshots).
    void setUiConnected (bool v)
    {
        if (uiConnectedParam != nullptr)
            uiConnectedParam->setValueNotifyingHost (v ? 1.0f : 0.0f);
    }

    // -- live recording ------------------------------------------------------
    void setRecordArmed (bool v) { recordArmed.store (v, std::memory_order_relaxed); }
    bool isRecordArmed() const { return recordArmed.load (std::memory_order_relaxed); }
    // Message thread: drains captured input notes into the document.
    void drainRecordedNotes();

    // -- built-in preview synth (Standalone only: no downstream instrument) --
    // Feeds from the same MIDI the plugin schedules, so audition, key clicks
    // and the internal play button are all audible without a host instrument.
    void previewSynthEvent (const juce::MidiMessage& m);
    void renderPreviewSynth (juce::AudioBuffer<float>& buffer);

    // -- drum kit name map (drum mode keyboard labels) -----------------------
    DrumMapData drumMap;
    void saveDrumMapPrefs() const;
    void clearDrumMap();

    // -- midi browser preview -------------------------------------------------
    // std::atomic<std::shared_ptr> is unavailable in AppleClang libc++
    // (shared_ptr is not trivially copyable), so the slot is a plain
    // shared_ptr guarded by a spinlock — same pattern as MidiClipDocument.
    // startPreview (message thread) swaps it while the audio thread copies the
    // pointer out once per block. The retired slot keeps a replaced snapshot
    // alive until the NEXT swap so the audio thread can never free the
    // snapshot it is currently rendering.
    mutable juce::SpinLock previewLock;
    std::shared_ptr<const DocumentSnapshot> previewSnap;
    std::shared_ptr<const DocumentSnapshot> previewRetired;
    std::atomic<bool> previewActive { false };

    std::shared_ptr<const DocumentSnapshot> currentPreviewSnap() const
    {
        const juce::SpinLock::ScopedLockType sl (previewLock);
        return previewSnap;
    }
    void swapPreviewSnap (std::shared_ptr<const DocumentSnapshot> s)
    {
        const juce::SpinLock::ScopedLockType sl (previewLock);
        previewRetired = std::move (previewSnap);
        previewSnap = std::move (s);
    }
    void clearPreviewSnap()
    {
        const juce::SpinLock::ScopedLockType sl (previewLock);
        previewRetired = std::move (previewSnap);
        previewSnap = nullptr;
    }
    void startPreview (const juce::File& file, bool useFileTempo = false); // parse file + loop it
    void stopPreview();
    void setPreviewPaused (bool paused) { engine.setPreviewPaused (paused); }
    bool isPreviewPausedForUi() const { return engine.isPreviewPausedForUi(); }
    double previewPosForUi() const { return engine.previewPosForUi(); }

    // -- midi browser folders (persisted in ui_prefs) -------------------------
    juce::Array<juce::var> browserFolders() const;
    void browserSetFolders (const juce::Array<juce::var>& folders);

    // -- internal transport (the UI's play button) ---------------------------
    void startInternalPlayback (double startPpq) { engine.startInternal (startPpq); }
    void stopInternalPlayback() { engine.stopInternal(); }

    // -- A/B document snapshots ---------------------------------------------
    juce::String toggleAb(); // returns the now-active slot ("A"/"B")

    // Latest transport state for UI polling (written on the audio thread).
    struct UiTransportState
    {
        std::atomic<double> ppq { 0.0 };
        std::atomic<bool> playing { false };
        std::atomic<bool> internalPlaying { false };
        std::atomic<bool> auditioning { false };
        std::atomic<double> auditionPpq { 0.0 };
        std::atomic<double> internalPpq { 0.0 };
        std::atomic<bool> ppqValid { false };
        std::atomic<double> loopStart { 0.0 };
        std::atomic<double> loopEnd { 0.0 };
        std::atomic<bool> loopValid { false };
        std::atomic<double> tempo { 120.0 };
        std::atomic<double> sampleRate { 48000.0 };
        std::atomic<int> sigNum { 4 };
        std::atomic<int> sigDen { 4 };
        // live output monitor: last pitch-bend / CC values we sent downstream
        std::atomic<int> lastPb { -1 };
        std::atomic<int> lastCcNumber { -1 };
        std::atomic<int> lastCcValue { -1 };
    };
    UiTransportState uiTransport;

    // MIDI input events, forwarded to the UI (step input, input display).
    struct MidiInEvent
    {
        bool isOn = false;
        int pitch = 0, channel = 1;
        float velocity = 0.0f;
    };
    bool popMidiInEvent (MidiInEvent& out);

private:
    PlaybackEngine engine;
    juce::AudioParameterBool* uiConnectedParam = nullptr;
    double currentSampleRate = 48000.0;

    // -- live recording ------------------------------------------------------
    std::atomic<bool> recordArmed { false };
    struct RecEv { bool on; int pitch, channel; float velocity; double ppq; };
    static constexpr int recCapacity = 256;
    std::atomic<int> recRead { 0 };
    std::atomic<int> recWrite { 0 };
    RecEv recRing[recCapacity];
    std::map<int, std::pair<double, float>> recPending; // (pitch*16+ch) -> {startPpq, vel}

    // -- A/B snapshots --------------------------------------------------------
    juce::var abSlots[2];
    int abActive = 0;

    // SPSC ring: audio thread produces, message thread consumes.
    static constexpr int midiInCapacity = 256;
    std::atomic<int> midiInRead { 0 };
    std::atomic<int> midiInWrite { 0 };
    MidiInEvent midiInRing[midiInCapacity];

    // -- preview synth voices (audio thread only, fixed pool) ----------------
    struct PreviewVoice
    {
        bool active = false;   // sounding (attack/sustain)
        bool releasing = false;
        int pitch = -1;
        float velocity = 0.0f;
        double phase = 0.0;
        float env = 0.0f;      // linear envelope 0..1
        int envSamples = 0;    // samples since note-on (attack ramp)
    };
    static constexpr int previewVoiceCount = 24;
    PreviewVoice previewVoices[previewVoiceCount];

    void addDemoContent();

    JUCE_DECLARE_NON_COPYABLE (PowerMidiEditorAudioProcessor)
};

} // namespace pme
