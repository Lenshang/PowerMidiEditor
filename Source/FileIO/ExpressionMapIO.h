#pragma once

#include <juce_core/juce_core.h>
#include "../Model/MidiClipDocument.h"

namespace pme
{

// Expression map importers:
//  - Cubase .expressionmap (XML)
//  - Ample Sound .exprmap ("Name,Keyswitch" text lines)
// The dispatcher sniffs the content, so a caller can hand it any of the
// supported files and get articulations back (empty vector = unrecognized).
class ExpressionMapIO
{
public:
    static std::vector<ArticulationDef> parse (const juce::File& file);

private:
    static std::vector<ArticulationDef> parseAmpleCsv (const juce::StringArray& lines);
    static std::vector<ArticulationDef> parseCubaseXml (const juce::File& file);
};

} // namespace pme
