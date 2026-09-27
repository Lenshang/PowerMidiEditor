#pragma once

#include <juce_core/juce_core.h>
#include "Util/VarUtil.h"

namespace pme
{

// User settings persisted with the plugin state. The UI owns the schema of
// `shortcuts` (a JSON object mapping action ids to bindings); C++ treats it
// as opaque except for persistence.
struct PluginSettings
{
    juce::String theme = "dark";
    juce::var shortcuts;                  // object; empty -> UI defaults
    double gridPpq = 0.25;                // grid resolution in quarter notes
    bool snap = true;
    bool triplet = false;
    juce::String lengthQuantize = "grid"; // "off" | "grid"
    bool autoQuantizeInput = false;
    juce::String snapBypass = "shift";    // modifier bypassing snap: shift|alt|ctrl|none
    juce::String lang = "en";             // UI language: en|zhHans|zhHant|ja

    juce::var toVar() const
    {
        auto o = new juce::DynamicObject();
        o->setProperty ("theme", theme);
        // Always emit an object: the frontend indexes settings.shortcuts
        // directly, and an omitted field would crash the settings panel.
        o->setProperty ("shortcuts",
            shortcuts.isVoid() ? juce::var (new juce::DynamicObject()) : shortcuts);
        o->setProperty ("gridPpq", gridPpq);
        o->setProperty ("snap", snap);
        o->setProperty ("triplet", triplet);
        o->setProperty ("lengthQuantize", lengthQuantize);
        o->setProperty ("autoQuantizeInput", autoQuantizeInput);
        o->setProperty ("snapBypass", snapBypass);
        o->setProperty ("lang", lang);
        return juce::var (o);
    }

    void loadFromVar (const juce::var& v)
    {
        auto* o = v.getDynamicObject();
        if (o == nullptr)
            return;
        theme = propStr (*o, "theme", "dark");
        auto sc = o->getProperty ("shortcuts");
        if (! sc.isVoid())
            shortcuts = sc;
        gridPpq = propNum (*o, "gridPpq", 0.25);
        snap = propBool (*o, "snap", true);
        triplet = propBool (*o, "triplet", false);
        lengthQuantize = propStr (*o, "lengthQuantize", "grid");
        autoQuantizeInput = propBool (*o, "autoQuantizeInput", false);
        snapBypass = propStr (*o, "snapBypass", "shift");
        lang = propStr (*o, "lang", "en");
    }
};

} // namespace pme
