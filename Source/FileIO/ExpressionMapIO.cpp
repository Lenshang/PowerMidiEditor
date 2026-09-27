#include "ExpressionMapIO.h"

namespace pme
{

std::vector<ArticulationDef> ExpressionMapIO::parse (const juce::File& file)
{
    auto lines = juce::StringArray::fromLines (file.loadFileAsString());

    // Ample Sound .exprmap: non-XML lines of "Name,Keyswitch". Sniff before
    // XML parsing so plain-text files never fall through to the XML path.
    bool csv = false;
    for (const auto& line : lines)
    {
        const auto t = line.trim();
        if (t.isEmpty() || t.startsWith ("<"))
            continue;
        const int comma = t.lastIndexOfChar (','); // names may contain commas
        const int ks = comma > 0 ? t.fromFirstOccurrenceOf (",", false, false).trim().getIntValue() : -1;
        if (comma > 0 && ks >= 0 && ks <= 127)
        {
            csv = true;
            break;
        }
    }
    if (csv)
        return parseAmpleCsv (lines);
    return parseCubaseXml (file);
}

std::vector<ArticulationDef> ExpressionMapIO::parseAmpleCsv (const juce::StringArray& lines)
{
    std::vector<ArticulationDef> out;
    juce::uint32 id = 1;
    for (const auto& line : lines)
    {
        const auto t = line.trim();
        if (t.isEmpty())
            continue;
        const int comma = t.lastIndexOfChar (','); // names may contain commas
        if (comma <= 0)
            continue;
        const int ks = t.fromLastOccurrenceOf (",", false, false).trim().getIntValue();
        ArticulationDef a;
        a.id = id++;
        a.name = t.upToLastOccurrenceOf (",", false, false).trim();
        a.keyswitch = juce::jlimit (-1, 127, ks);
        a.cc = -1;
        out.push_back (a);
    }
    return out;
}

std::vector<ArticulationDef> ExpressionMapIO::parseCubaseXml (const juce::File& file)
{
    std::vector<ArticulationDef> out;
    auto xml = juce::XmlDocument::parse (file);
    if (xml == nullptr)
        return out;

    auto* mapEl = xml->getChildByName ("ExpressionMap");
    auto* parent = mapEl != nullptr ? mapEl : xml.get();

    juce::uint32 id = 1;
    for (auto* art = parent->getFirstChildElement(); art != nullptr; art = art->getNextElement())
    {
        if (! art->hasTagName ("Articulation"))
            continue;
        ArticulationDef a;
        a.id = id++;
        a.name = art->getStringAttribute ("szName", "Art " + juce::String ((int) a.id));
        a.keyswitch = -1;
        a.cc = -1;
        if (auto* pitch = art->getChildByName ("Pitch"))
        {
            const int p = pitch->getAllSubText().trim().getIntValue();
            if (p >= 0 && p <= 127)
                a.keyswitch = p;
        }
        out.push_back (a);
    }
    return out;
}

} // namespace pme
