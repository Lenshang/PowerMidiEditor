#pragma once

#include <juce_audio_utils/juce_audio_utils.h>
#include "PluginProcessor.h"
#include "Bridge/UiBridge.h"

namespace pme
{

class PowerMidiEditorAudioProcessorEditor : public juce::AudioProcessorEditor
{
public:
    explicit PowerMidiEditorAudioProcessorEditor (PowerMidiEditorAudioProcessor&);
    ~PowerMidiEditorAudioProcessorEditor() override = default;

    void paint (juce::Graphics&) override;
    void resized() override;

private:
    PowerMidiEditorAudioProcessor& processorRef;
    UiBridge bridge;
    juce::WebBrowserComponent& browser;

    JUCE_DECLARE_NON_COPYABLE (PowerMidiEditorAudioProcessorEditor)
};

} // namespace pme
