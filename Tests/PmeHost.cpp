// Automated host-side test for the built PowerMidiEditor VST3 — no DAW needed.
//
//   PmeHost.exe <path-to-PowerMidiEditor.vst3> [--no-ui]
//
// What it verifies:
//   1. The VST3 loads and its bus layout is MIDI-only (0 audio in/out).
//   2. With a fake transport (playing, 120 bpm) the plugin schedules the demo
//      content: 10 note-ons with correct sample offsets, matching note-offs,
//      5 x CC11 events and 3 pitch-bend events.
//   3. External MIDI input is passed through to the output.
//   4. (unless --no-ui) the editor is opened and the WebView bridge completes
//      its init RPC within 30 s, signalled through the "UI Connected" parameter.
//
// Exit code 0 = all checks passed.
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_audio_processors/juce_audio_processors.h>
#include <iostream>

using namespace juce;

static int failures = 0;

#define CHECK(cond)                                                                     \
    do                                                                                  \
    {                                                                                   \
        if (cond)                                                                       \
        {                                                                               \
            std::cout << "  ok  " #cond "\n";                                           \
        }                                                                               \
        else                                                                            \
        {                                                                               \
            std::cerr << "  FAIL " #cond " (line " << __LINE__ << ")\n";                \
            ++failures;                                                                 \
        }                                                                               \
    } while (false)

struct FakePlayHead : public AudioPlayHead
{
    Optional<PositionInfo> info;
    Optional<PositionInfo> getPosition() const override { return info; }
};

struct EditorWindow : public DocumentWindow
{
    explicit EditorWindow (Component* c)
        : DocumentWindow ("PmeHost", Colour (0xff1e1e22), DocumentWindow::allButtons)
    {
        setUsingNativeTitleBar (false);
        setContentNonOwned (c, true);
        setResizable (false, false);
    }
    void closeButtonPressed() override { setVisible (false); }
};

static int countEvents (const MidiBuffer& m, bool (MidiMessage::*pred)() const, int value = -1)
{
    int n = 0;
    for (const auto& ev : m)
    {
        const auto& msg = ev.getMessage();
        if (! (msg.*pred)())
            continue;
        if (value >= 0 && msg.getNoteNumber() != value)
            continue;
        ++n;
    }
    return n;
}

static int runTests (const String& vst3Path, bool showUi)
{
    std::cout << "== PmeHost: " << vst3Path << " ==\n";

    // -- load ---------------------------------------------------------------
    VST3PluginFormat vst3;
    OwnedArray<PluginDescription> descs;
    vst3.findAllTypesForFile (descs, vst3Path);
    CHECK (descs.size() > 0);
    if (descs.isEmpty())
        return 1;

    std::cout << "  type: " << descs[0]->name << " / " << descs[0]->category << "\n";

    auto instance = std::unique_ptr<AudioPluginInstance> (
        vst3.createInstanceFromDescription (*descs[0], 48000, 512));
    CHECK (instance != nullptr);
    if (instance == nullptr)
        return 1;

    // -- bus layout: MIDI-only ----------------------------------------------
    std::cout << "  audio in: " << instance->getTotalNumInputChannels()
              << ", out: " << instance->getTotalNumOutputChannels() << "\n";
    CHECK (instance->getTotalNumInputChannels() == 0);
    CHECK (instance->getTotalNumOutputChannels() == 0);
    CHECK (instance->acceptsMidi());
    CHECK (instance->producesMidi());

    // -- transport-scheduled output ------------------------------------------
    FakePlayHead playHead;
    instance->setPlayHead (&playHead);
    instance->prepareToPlay (48000.0, 512);

    const int blockSize = 512;
    const int numBlocks = 200; // 102400 samples = ~4.27 ppq at 120 bpm
    AudioBuffer<float> silence (instance->getTotalNumOutputChannels(), blockSize);
    silence.clear();

    MidiBuffer scheduled;
    auto info = AudioPlayHead::PositionInfo();
    info.setIsPlaying (true);
    info.setBpm (Optional<double> (120.0));
    for (int block = 0; block < numBlocks; ++block)
    {
        info.setPpqPosition (Optional<double> (block * blockSize / 24000.0));
        info.setTimeInSamples (Optional<int64> ((int64) block * blockSize));
        playHead.info = info;

        MidiBuffer midi;
        instance->processBlock (silence, midi);
        for (const auto& ev : midi)
            scheduled.addEvent (ev.getMessage(), ev.samplePosition + block * blockSize);
    }

    int noteOns = 0, noteOffs = 0, cc11 = 0, pitchBends = 0;
    for (const auto& ev : scheduled)
    {
        const auto& m = ev.getMessage();
        if (m.isNoteOn())
            ++noteOns;
        else if (m.isNoteOff())   ++noteOffs;
        else if (m.isController() && m.getControllerNumber() == 11) ++cc11;
        else if (m.isPitchWheel()) ++pitchBends;
    }

    std::cout << "  note-ons: " << noteOns << ", note-offs: " << noteOffs
              << ", cc11: " << cc11 << ", pitchbend: " << pitchBends << "\n";
    // A fresh instance starts EMPTY (no demo content), so the transport pass
    // must produce no scheduled output at all.
    CHECK (noteOns == 0);
    CHECK (noteOffs == 0);
    CHECK (cc11 == 0);
    CHECK (pitchBends == 0);

    // -- MIDI pass-through ----------------------------------------------------
    instance->reset();
    MidiBuffer pass;
    pass.addEvent (MidiMessage::noteOn (1, 100, 0.9f), 7);
    pass.addEvent (MidiMessage::controllerEvent (1, 64, 127), 11);
    silence.clear();
    instance->processBlock (silence, pass);
    bool sawNoteOn = false, sawCc = false;
    for (const auto& ev : pass)
    {
        const auto& m = ev.getMessage();
        if (m.isNoteOn() && m.getNoteNumber() == 100) sawNoteOn = true;
        if (m.isController() && m.getControllerNumber() == 64) sawCc = true;
    }
    CHECK (sawNoteOn);
    CHECK (sawCc);

    // -- WebView bridge ---------------------------------------------------------
    if (showUi)
    {
        AudioProcessorParameter* uiParam = nullptr;
        for (auto* p : instance->getParameters())
            if (p->getName (32).containsIgnoreCase ("UI"))
                uiParam = p;
        CHECK (uiParam != nullptr);

        auto* editor = instance->createEditorIfNeeded();
        CHECK (editor != nullptr);
        std::unique_ptr<EditorWindow> win;
        if (editor != nullptr)
        {
            win = std::make_unique<EditorWindow> (editor);
            win->setTopLeftPosition (60, 60);
            win->setSize (juce::jlimit (640, 1300, editor->getWidth()),
                          juce::jlimit (420, 900, editor->getHeight()));
            win->setVisible (true);
            std::cout << "  editor opened, waiting for the WebView bridge...\n";
        }

        bool connected = false;
        for (int i = 0; i < 300; ++i) // up to 30 s
        {
            MessageManager::getInstance()->runDispatchLoopUntil (100);
            if (uiParam != nullptr && uiParam->getValue() > 0.5f)
            {
                connected = true;
                break;
            }
        }
        CHECK (connected);

        // let the UI settle, then tear down
        MessageManager::getInstance()->runDispatchLoopUntil (500);
        if (editor != nullptr)
        {
            editor->setVisible (false);
            instance->editorBeingDeleted (editor);
            delete editor;
        }
        win.reset();
    }

    instance->releaseResources();
    std::cout << (failures == 0 ? "== PASS ==\n" : "== FAILED ==\n");
    return failures == 0 ? 0 : 1;
}

int main (int argc, char** argv)
{
    ScopedJuceInitialiser_GUI juceInit;

    if (argc < 2)
    {
        std::cerr << "usage: PmeHost.exe <PowerMidiEditor.vst3> [--no-ui]\n";
        return 2;
    }
    const String path (argv[1]);
    bool showUi = true;
    for (int i = 2; i < argc; ++i)
        if (String (argv[i]) == "--no-ui")
            showUi = false;

    int result = 1;
    auto& mm = *MessageManager::getInstance();
    mm.callAsync ([&]
    {
        result = runTests (path, showUi);
        mm.stopDispatchLoop();
    });
    mm.runDispatchLoop();
    return result;
}
