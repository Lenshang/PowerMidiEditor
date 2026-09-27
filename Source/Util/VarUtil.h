#pragma once

#include <juce_core/juce_core.h>

namespace pme
{

// juce::DynamicObject::getProperty() takes a single argument in JUCE 9, so
// defaulted reads go through these small helpers.
inline double varNum (const juce::var& v, double dflt = 0.0)
{
    return v.isVoid() ? dflt : (double) v;
}

inline bool varBool (const juce::var& v, bool dflt = false)
{
    return v.isVoid() ? dflt : (bool) v;
}

inline juce::String varStr (const juce::var& v, const char* dflt = "")
{
    return v.isVoid() ? juce::String (dflt) : v.toString();
}

inline double propNum (const juce::DynamicObject& o, const char* key, double dflt = 0.0)
{
    return varNum (o.getProperty (key), dflt);
}

inline bool propBool (const juce::DynamicObject& o, const char* key, bool dflt = false)
{
    return varBool (o.getProperty (key), dflt);
}

inline juce::String propStr (const juce::DynamicObject& o, const char* key, const char* dflt = "")
{
    return varStr (o.getProperty (key), dflt);
}

} // namespace pme
