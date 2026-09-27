#pragma once

#include <juce_gui_extra/juce_gui_extra.h>
#include "../PluginProcessor.h"

namespace pme
{

// Owns the WebBrowserComponent and implements the UI<->C++ bridge.
//
// UI -> C++: a single native function `invoke(name, payload)` returning
//            {ok, data|error} (RPC, awaited by the frontend).
// C++ -> UI: a single event channel `pme` carrying {kind, ...} messages
//            (doc / settings / transport / midi).
//
// The frontend runs either from the embedded asset zip or (PME dev builds)
// straight from the Vite dev server.
class UiBridge : private juce::Timer
{
public:
    explicit UiBridge (PowerMidiEditorAudioProcessor& processor);
    ~UiBridge() override;

    juce::WebBrowserComponent& getBrowser() { return *browser; }

private:
    juce::WebBrowserComponent::Options buildOptions();
    std::unique_ptr<juce::WebBrowserComponent> createBrowser();
    void loadResourcesFromZip();

    std::optional<juce::WebBrowserComponent::Resource> getResource (const juce::String& url);
    juce::var handleInvoke (const juce::Array<juce::var>& args);

    void timerCallback() override;
    void pushDoc();
    void pushSettings();
    void pushTransport();
    void pushMidiIn();
    void push (const char* kind, const juce::var& payload);
    void pushToast (const juce::String& message);
    // Push a toast carrying an i18n key + substitution params for the UI to translate.
    void pushToastKey (const juce::String& key,
        std::vector<std::pair<juce::String, juce::String>> params = {});
    void exportMidiToFile (const juce::String& suggestedName);
    void importMidiFromFile();
    void exportExpressionMap (const juce::String& suggestedName);
    void importExpressionMap();
    void importCubaseExpressionMap();
    void dragMidiOut();
    void saveProject();
    void openProject();

    PowerMidiEditorAudioProcessor& processor;
    std::unique_ptr<juce::WebBrowserComponent> browser;

    struct ResourceData
    {
        std::vector<std::byte> bytes;
        juce::String mime;
    };
    std::map<juce::String, ResourceData> resources;

    juce::uint64 lastDocRevision = 0;
    juce::uint64 lastSettingsRevision = 0;
    bool docWasPushed = false;

    std::vector<std::unique_ptr<juce::FileChooser>> pendingChoosers;

    double lastTransportPpq = -1.0;
    bool lastTransportPpqValid = false;
    bool lastTransportLoopValid = false;
    double lastTransportLoopStart = 0.0;
    double lastTransportLoopEnd = 0.0;
    double lastTransportTempo = 0.0;
    bool lastTransportInternal = false;
    double lastTransportInternalPpq = -1.0;
    bool lastTransportAuditioning = false;
    double lastTransportAuditionPpq = -1.0;
    int lastPb = -1;
    int lastCcNumber = -1;
    int lastCcValue = -1;

    JUCE_DECLARE_NON_COPYABLE (UiBridge)
};

} // namespace pme
