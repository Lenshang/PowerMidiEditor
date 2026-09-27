#include "PluginProcessor.h"
#include "PluginEditor.h"

namespace pme
{

PowerMidiEditorAudioProcessor::PowerMidiEditorAudioProcessor()
    : AudioProcessor (
#if PME_MIDI_ONLY
          BusesProperties()
#else
          BusesProperties()
              .withInput ("Input", juce::AudioChannelSet::stereo(), true)
              .withOutput ("Output", juce::AudioChannelSet::stereo(), true)
#endif
      )
{
    addParameter (uiConnectedParam = new juce::AudioParameterBool (
        juce::ParameterID { "uiConnected", 1 },
        "UI Connected", false,
        juce::AudioParameterBoolAttributes().withAutomatable (false)));

    // A fresh instance starts empty — the demo content is for the browser dev
    // mock only, not for real sessions.
    loadUiPrefs();
}

void PowerMidiEditorAudioProcessor::addDemoContent()
{
    // A short C-major arpeggio with an expression ramp, so a fresh instance
    // shows notes as well as the CC / pitch-bend lanes at work.
    struct Demo { int p; double s, l; };
    const Demo demo[] = {
        { 60, 0.0, 0.5 }, { 64, 0.5, 0.5 }, { 67, 1.0, 0.5 }, { 72, 1.5, 0.5 },
        { 71, 2.0, 0.5 }, { 67, 2.5, 0.5 }, { 64, 3.0, 0.5 }, { 60, 3.5, 0.5 },
    };
    auto doc = new juce::DynamicObject();
    juce::Array<juce::var> arr;
    juce::Array<juce::var> ccArr;
    juce::Array<juce::var> pbArr;
    double id = 1;
    for (auto& d : demo)
    {
        auto n = new juce::DynamicObject();
        n->setProperty ("id", id++);
        n->setProperty ("p", d.p);
        n->setProperty ("s", d.s);
        n->setProperty ("l", d.l);
        n->setProperty ("v", juce::var (0.85));
        n->setProperty ("m", false);
        n->setProperty ("c", 1);
        arr.add (juce::var (n));
    }
    // expression swell across the bar
    const double ccT[] = { 0.0, 1.0, 2.0, 3.0, 4.0 };
    const int    ccV[] = { 70,  100, 110,  85,  70 };
    for (int i = 0; i < 5; ++i)
    {
        auto e = new juce::DynamicObject();
        e->setProperty ("id", id++);
        e->setProperty ("cc", 11);
        e->setProperty ("c", 1);
        e->setProperty ("t", ccT[i]);
        e->setProperty ("v", ccV[i]);
        ccArr.add (juce::var (e));
    }
    // a full-range bend in bar 2 (+2 semitones at the receiver's default range)
    const double pbT[] = { 1.0, 1.5, 2.0 };
    const int    pbV[] = { 8192, 16383, 8192 };
    for (int i = 0; i < 3; ++i)
    {
        auto e = new juce::DynamicObject();
        e->setProperty ("id", id++);
        e->setProperty ("c", 1);
        e->setProperty ("t", pbT[i]);
        e->setProperty ("v", pbV[i]);
        pbArr.add (juce::var (e));
    }
    doc->setProperty ("nextId", id);
    doc->setProperty ("notes", arr);
    doc->setProperty ("cc", ccArr);
    doc->setProperty ("pb", pbArr);
    document.loadFromVar (juce::var (doc));
}

//==============================================================================
void PowerMidiEditorAudioProcessor::prepareToPlay (double sampleRate, int /*samplesPerBlock*/)
{
    currentSampleRate = sampleRate;
    uiTransport.sampleRate.store (sampleRate, std::memory_order_relaxed);
}

bool PowerMidiEditorAudioProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
#if PME_MIDI_ONLY
    // The Standalone has no downstream instrument, so it opens a stereo output
    // and the built-in preview synth renders the scheduled notes audibly.
    // Plugin formats stay strictly MIDI-only.
    if (wrapperType == juce::AudioProcessor::wrapperType_Standalone)
        return layouts.getMainInputChannelSet().isDisabled()
            && (layouts.getMainOutputChannelSet().isDisabled()
                || layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo());
    return layouts.getMainInputChannelSet().isDisabled()
        && layouts.getMainOutputChannelSet().isDisabled();
#else
    const auto& in = layouts.getMainInputChannelSet();
    const auto& out = layouts.getMainOutputChannelSet();
    if (out.isDisabled())
        return false;
    if (in.isDisabled())
        return out.size() <= 2;
    return in == out && in.size() <= 2;
#endif
}

void PowerMidiEditorAudioProcessor::processBlock (juce::AudioBuffer<float>& buffer,
                                                  juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;
    const int numSamples = buffer.getNumSamples();
    if (numSamples == 0)
        return;

#if ! PME_MIDI_ONLY
    // Audio pass-through (the plugin never alters audio; the buses exist only
    // so hosts that dislike MIDI-only VST3s still load us).
    const int numIn = getTotalNumInputChannels();
    const int numOut = getTotalNumOutputChannels();
    for (int ch = 0; ch < numOut; ++ch)
    {
        if (ch < numIn)
            buffer.copyFrom (ch, 0, buffer, ch, 0, numSamples);
        else
            buffer.clear (ch, 0, numSamples);
    }
#endif

    // -- gather transport -------------------------------------------------
    EngineInputs in;
    in.snapshot = document.getSnapshot().get();
    in.numSamples = numSamples;
    in.sampleRate = currentSampleRate;

    if (auto* playHead = getPlayHead())
    {
        if (auto pos = playHead->getPosition())
        {
            in.playing = pos->getIsPlaying();
            if (auto ppq = pos->getPpqPosition())
            {
                in.ppqValid = true;
                in.ppq = *ppq;
            }
            if (auto bpm = pos->getBpm())
                in.tempo = *bpm;
            if (auto ts = pos->getTimeInSamples())
            {
                in.timeValid = true;
                in.timeInSamples = *ts;
            }
            if (pos->getIsLooping())
            {
                if (auto lp = pos->getLoopPoints())
                {
                    in.loopValid = true;
                    in.loopStartPpq = lp->ppqStart;
                    in.loopEndPpq = lp->ppqEnd;
                }
            }
            if (auto sig = pos->getTimeSignature())
            {
                uiTransport.sigNum.store (sig->numerator, std::memory_order_relaxed);
                uiTransport.sigDen.store (sig->denominator, std::memory_order_relaxed);
            }
        }
    }

    // -- forward input MIDI to the UI watcher (note on/off only) -----------
    const bool recThisBlock = recordArmed.load (std::memory_order_relaxed)
        && in.playing && in.ppqValid;
    const double ppqPerSample = (in.tempo / 60.0) / in.sampleRate;

    for (const auto metadata : midi)
    {
        const auto& msg = metadata.getMessage();
        if (msg.isNoteOn() || msg.isNoteOff())
        {
            if (recThisBlock)
            {
                auto w = recWrite.load (std::memory_order_relaxed);
                auto r = recRead.load (std::memory_order_acquire);
                auto next = (w + 1) % recCapacity;
                if (next != r)
                {
                    const double recPpq = in.ppq
                        + (double) metadata.samplePosition * ppqPerSample;
                    recRing[w] = { msg.isNoteOn(), msg.getNoteNumber(), msg.getChannel(),
                                   msg.getFloatVelocity(), recPpq };
                    recWrite.store (next, std::memory_order_release);
                }
            }

            auto w = midiInWrite.load (std::memory_order_relaxed);
            auto r = midiInRead.load (std::memory_order_acquire);
            auto next = (w + 1) % midiInCapacity;
            if (next != r)
            {
                midiInRing[w] = { msg.isNoteOn(), msg.getNoteNumber(),
                                  msg.getChannel(), msg.getFloatVelocity() };
                midiInWrite.store (next, std::memory_order_release);
            }
        }
    }

    // -- schedule pattern notes into the output -----------------------------
    engine.render (midi, in);

    // -- output monitor: the last PB / CC we actually sent downstream --------
    int monPb = -1, monCcNumber = -1, monCcValue = -1;
    for (const auto metadata : midi)
    {
        const auto& m = metadata.getMessage();
        if (m.isPitchWheel())
            monPb = m.getPitchWheelValue();
        else if (m.isController())
        {
            monCcNumber = m.getControllerNumber();
            monCcValue = m.getControllerValue();
        }
        else if (m.isNoteOn() || m.isNoteOff())
            previewSynthEvent (m);
    }
    auto monRelaxed = std::memory_order_relaxed;
    if (monPb >= 0) uiTransport.lastPb.store (monPb, monRelaxed);
    if (monCcNumber >= 0)
    {
        uiTransport.lastCcNumber.store (monCcNumber, monRelaxed);
        uiTransport.lastCcValue.store (monCcValue, monRelaxed);
    }
    renderPreviewSynth (buffer);

    // -- publish UI transport snapshot ---------------------------------------
    auto relaxed = std::memory_order_relaxed;
    uiTransport.ppq.store (in.ppqValid ? in.ppq : 0.0, relaxed);
    uiTransport.ppqValid.store (in.ppqValid, relaxed);
    uiTransport.playing.store (in.playing, relaxed);
    uiTransport.internalPlaying.store (engine.isInternalPlayingForUi(), relaxed);
    uiTransport.internalPpq.store (engine.internalCursorForUi(), relaxed);
    uiTransport.auditioning.store (engine.isAuditioningForUi(), relaxed);
    uiTransport.auditionPpq.store (engine.auditionCursorForUi(), relaxed);
    uiTransport.tempo.store (in.tempo, relaxed);
    uiTransport.loopValid.store (in.loopValid, relaxed);
    uiTransport.loopStart.store (in.loopStartPpq, relaxed);
    uiTransport.loopEnd.store (in.loopEndPpq, relaxed);
}

//==============================================================================
// Built-in preview synth (Standalone only). Minimal polyphonic sine+octave
// voice pool driven by the very MIDI the plugin schedules, so audition, key
// clicks, step input and the internal play button are audible on their own.
void PowerMidiEditorAudioProcessor::previewSynthEvent (const juce::MidiMessage& m)
{
    if (getTotalNumOutputChannels() == 0)
        return; // MIDI-only plugin formats have nowhere to render audio

    if (m.isAllNotesOff() || m.isAllSoundOff())
    {
        for (auto& v : previewVoices)
            v = PreviewVoice{};
        return;
    }

    if (m.isNoteOn())
    {
        PreviewVoice* slot = nullptr;
        for (auto& v : previewVoices)
            if (! v.active && ! v.releasing && v.env <= 0.0f) { slot = &v; break; }
        if (slot == nullptr) // steal the quietest voice
            for (auto& v : previewVoices)
                if (slot == nullptr || v.env < slot->env)
                    slot = &v;
        slot->active = true;
        slot->releasing = false;
        slot->pitch = m.getNoteNumber();
        slot->velocity = m.getFloatVelocity();
        slot->env = 0.0f;
        slot->envSamples = 0;
        return;
    }

    if (m.isNoteOff())
    {
        for (auto& v : previewVoices)
            if (v.pitch == m.getNoteNumber() && v.active)
            {
                v.releasing = true;
                v.active = false;
            }
    }
}

void PowerMidiEditorAudioProcessor::renderPreviewSynth (juce::AudioBuffer<float>& buffer)
{
    const int numOut = getTotalNumOutputChannels();
    if (numOut == 0)
        return;
    const int numSamples = buffer.getNumSamples();
    const double sr = currentSampleRate > 0.0 ? currentSampleRate : 48000.0;
    const float attackPerSample = 1.0f / (float) juce::jmax (1, (int) (0.004 * sr));
    const float releasePerSample = 1.0f / (float) juce::jmax (1, (int) (0.09 * sr));

    for (auto& v : previewVoices)
    {
        if (! v.active && ! v.releasing)
            continue;
        const float step = (float) (440.0 * std::pow (2.0, (v.pitch - 69) / 12.0) / sr);
        const float target = v.active ? v.velocity * 0.20f : 0.0f;
        const float rate = v.active ? attackPerSample : releasePerSample;

        for (int i = 0; i < numSamples; ++i)
        {
            v.env += juce::jlimit (-rate, rate, target - v.env);
            const float smp = (float) (0.75 * std::sin (v.phase) + 0.25 * std::sin (2.0 * v.phase)) * v.env;
            for (int ch = 0; ch < numOut; ++ch)
                buffer.addSample (ch, i, smp);
            v.phase += step;
            if (v.phase >= juce::MathConstants<double>::twoPi)
                v.phase -= juce::MathConstants<double>::twoPi;
            if (! v.active && v.env <= 0.0001f)
            {
                v = PreviewVoice{};
                break;
            }
        }
    }
}

//==============================================================================
// Live recording: message-thread drain of the recFIFO into the document.
void PowerMidiEditorAudioProcessor::drainRecordedNotes()
{
    struct FinishedPair { double start; float vel; int channel; int pitch; };
    std::vector<FinishedPair> finished;

    auto r = recRead.load (std::memory_order_relaxed);
    auto w = recWrite.load (std::memory_order_acquire);
    while (r != w)
    {
        const auto& ev = recRing[r];
        r = (r + 1) % recCapacity;
        const int key = ev.pitch * 16 + ev.channel;
        if (ev.on)
        {
            recPending[key] = { ev.ppq, ev.velocity };
        }
        else
        {
            auto it = recPending.find (key);
            if (it != recPending.end())
            {
                finished.push_back ({ it->second.first, it->second.second,
                                      ev.channel, ev.pitch });
                recPending.erase (it);
            }
        }
    }
    recRead.store (r, std::memory_order_release);

    if (finished.empty())
        return;

    const bool quant = settings.autoQuantizeInput;
    const double grid = juce::jmax (0.03125, settings.gridPpq);

    document.beginTransaction ("录音");
    for (const auto& f : finished)
    {
        Note n;
        n.pitch = f.pitch;
        n.start = quant ? std::floor (f.start / grid) * grid : f.start;
        n.length = juce::jmax (grid, f.start + grid - n.start); // >= one grid cell
        n.velocity = juce::jlimit (0.05f, 1.0f, f.vel);
        n.channel = f.channel;
        document.addNote (n);
    }
    document.commitTransaction();
}

bool PowerMidiEditorAudioProcessor::popMidiInEvent (MidiInEvent& out)
{
    auto r = midiInRead.load (std::memory_order_relaxed);
    auto w = midiInWrite.load (std::memory_order_acquire);
    if (r == w)
        return false;
    out = midiInRing[r];
    midiInRead.store ((r + 1) % midiInCapacity, std::memory_order_release);
    return true;
}

//==============================================================================
void PowerMidiEditorAudioProcessor::updateSettingsFromUi (const juce::var& v)
{
    auto* o = v.getDynamicObject();
    if (o == nullptr)
        return;
    // merge: only overwrite provided keys
    if (o->hasProperty ("theme"))
        settings.theme = o->getProperty ("theme").toString();
    if (o->hasProperty ("shortcuts"))
        settings.shortcuts = o->getProperty ("shortcuts");
    if (o->hasProperty ("gridPpq"))
        settings.gridPpq = (double) o->getProperty ("gridPpq");
    if (o->hasProperty ("snap"))
        settings.snap = (bool) o->getProperty ("snap");
    if (o->hasProperty ("triplet"))
        settings.triplet = (bool) o->getProperty ("triplet");
    if (o->hasProperty ("lengthQuantize"))
        settings.lengthQuantize = o->getProperty ("lengthQuantize").toString();
    if (o->hasProperty ("autoQuantizeInput"))
        settings.autoQuantizeInput = (bool) o->getProperty ("autoQuantizeInput");
    if (o->hasProperty ("snapBypass"))
        settings.snapBypass = o->getProperty ("snapBypass").toString();
    if (o->hasProperty ("lang"))
        settings.lang = o->getProperty ("lang").toString();
    saveUiPrefs(); // remember UI preferences for future instances
    settingsRevision.fetch_add (1, std::memory_order_relaxed);
}

juce::String PowerMidiEditorAudioProcessor::toggleAb()
{
    abSlots[abActive] = document.toVar();
    abActive = 1 - abActive;
    if (! abSlots[abActive].isVoid())
        document.loadFromVar (abSlots[abActive]);
    return abActive == 0 ? "A" : "B";
}

//==============================================================================
juce::File PowerMidiEditorAudioProcessor::uiPrefsFile()
{
    return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
        .getChildFile ("PowerMidiEditor")
        .getChildFile ("ui_prefs.json");
}

void PowerMidiEditorAudioProcessor::saveUiPrefs() const
{
    auto o = new juce::DynamicObject();
    o->setProperty ("theme", settings.theme);
    o->setProperty ("lang", settings.lang);
    o->setProperty ("snapBypass", settings.snapBypass);
    if (! settings.shortcuts.isVoid())
        o->setProperty ("shortcuts", settings.shortcuts);
    const auto json = juce::JSON::toString (juce::var (o), juce::JSON::FormatOptions().withSpacing (juce::JSON::Spacing::multiLine));
    uiPrefsFile().getParentDirectory().createDirectory();
    uiPrefsFile().replaceWithText (json);
}

void PowerMidiEditorAudioProcessor::loadUiPrefs()
{
    const auto f = uiPrefsFile();
    if (! f.existsAsFile())
        return;
    auto parsed = juce::JSON::parse (f.loadFileAsString());
    auto* o = parsed.getDynamicObject();
    if (o == nullptr)
        return;
    settings.theme = propStr (*o, "theme", settings.theme.toRawUTF8());
    settings.lang = propStr (*o, "lang", settings.lang.toRawUTF8());
    settings.snapBypass = propStr (*o, "snapBypass", settings.snapBypass.toRawUTF8());
    auto sc = o->getProperty ("shortcuts");
    if (! sc.isVoid())
        settings.shortcuts = sc;
}

//==============================================================================
void PowerMidiEditorAudioProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    auto root = new juce::DynamicObject();
    root->setProperty ("version", 1);
    root->setProperty ("doc", document.toVar());
    root->setProperty ("settings", settings.toVar());
    auto str = juce::JSON::toString (juce::var (root), true);
    destData.append (str.toRawUTF8(), str.getNumBytesAsUTF8());
}

void PowerMidiEditorAudioProcessor::setStateInformation (const void* data, int sizeInBytes)
{
    auto str = juce::String::createStringFromData (data, sizeInBytes);
    auto v = juce::JSON::parse (str);
    auto* root = v.getDynamicObject();
    if (root == nullptr)
        return;
    if (auto docVar = root->getProperty ("doc"); ! docVar.isVoid())
        document.loadFromVar (docVar);
    if (auto settingsVar = root->getProperty ("settings"); ! settingsVar.isVoid())
        settings.loadFromVar (settingsVar);
    settingsRevision.fetch_add (1, std::memory_order_relaxed);
}

juce::AudioProcessorEditor* PowerMidiEditorAudioProcessor::createEditor()
{
    return new PowerMidiEditorAudioProcessorEditor (*this);
}

} // namespace pme

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new pme::PowerMidiEditorAudioProcessor();
}
