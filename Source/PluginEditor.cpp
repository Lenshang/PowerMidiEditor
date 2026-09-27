#include "PluginEditor.h"

namespace pme
{

PowerMidiEditorAudioProcessorEditor::PowerMidiEditorAudioProcessorEditor (
    PowerMidiEditorAudioProcessor& p)
    : juce::AudioProcessorEditor (p),
      processorRef (p),
      bridge (p),
      browser (bridge.getBrowser())
{
    addAndMakeVisible (browser);
    setResizeLimits (640, 400, 8192, 8192);
    setSize (1400, 860);
}

void PowerMidiEditorAudioProcessorEditor::paint (juce::Graphics& g)
{
    g.fillAll (juce::Colour (0xff1e1e22)); // behind the webview (avoid white flash)
}

void PowerMidiEditorAudioProcessorEditor::resized()
{
    browser.setBounds (getLocalBounds());
}

} // namespace pme
