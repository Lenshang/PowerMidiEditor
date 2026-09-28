#include "DrumMapIO.h"

namespace pme
{

namespace
{
    void addEntry (DrumMapData& out, const juce::String& name,
                   int inNote, int inChannel, int outNote, int channel)
    {
        if (inNote < 0 || inNote > 127 || outNote < 0 || outNote > 127)
            return;
        if (name.trim().isEmpty())
            return;
        // keep the first rule per source pitch; later duplicates don't override
        for (const auto& e : out.entries)
            if (e.inNote == inNote)
                return;
        out.entries.push_back ({ name.trim(), inNote, inChannel, outNote, channel });
    }
}

bool DrumMapIO::parse (const juce::File& file, DrumMapData& out)
{
    const auto text = file.loadFileAsString();
    out = {};
    out.mapName = file.getFileNameWithoutExtension();

    if (parseBwdrm (text, out))
        return true;
    out.entries.clear();
    if (parseCubaseDrm (text, out))
        return true;
    out = {};
    return false;
}

// "Name,SourceNote,SourceChannel,TargetNote,TargetChannel"
// Channel 0 = any/keep (PowerDrumMapper convention).
bool DrumMapIO::parseBwdrm (const juce::String& text, DrumMapData& out)
{
    auto lines = juce::StringArray::fromLines (text);
    bool sawValid = false;

    for (const auto& line : lines)
    {
        const auto trimmed = line.trim();
        if (trimmed.isEmpty() || trimmed.startsWith ("<"))
            continue;

        auto tokens = juce::StringArray::fromTokens (trimmed, ",", "");
        tokens.removeEmptyStrings (false);
        if (tokens.size() < 5)
            continue;

        const auto name = tokens[0].trim();
        const int inNote = juce::jlimit (0, 127, tokens[1].getIntValue());
        const int inChannel = juce::jlimit (0, 16, tokens[2].getIntValue());
        const int outNote = juce::jlimit (0, 127, tokens[3].getIntValue());
        const int outChannel = juce::jlimit (0, 16, tokens[4].getIntValue());
        if (name.isEmpty())
            continue;

        addEntry (out, name, inNote, inChannel, outNote, outChannel);
        sawValid = true;
    }

    if (! sawValid)
        out.entries.clear();
    return sawValid;
}

// Cubase drum map XML: INote = input pitch, ONote = output pitch,
// Channel is 0-based (0..15 → 1..16); -1/-2 = keep original channel.
bool DrumMapIO::parseCubaseDrm (const juce::String& xmlText, DrumMapData& out)
{
    auto doc = juce::XmlDocument::parse (xmlText);
    if (doc == nullptr || ! doc->hasTagName ("DrumMap"))
        return false;

    bool sawValid = false;
    for (auto* listElem = doc->getFirstChildElement(); listElem != nullptr;
         listElem = listElem->getNextElement())
    {
        if (! listElem->hasTagName ("list") || listElem->getStringAttribute ("name") != "Map")
            continue;

        for (auto* item = listElem->getFirstChildElement(); item != nullptr;
             item = item->getNextElement())
        {
            if (! item->hasTagName ("item"))
                continue;

            int inNote = -1, outNote = -1, cubaseCh = -1;
            juce::String name;
            for (auto* prop = item->getFirstChildElement(); prop != nullptr;
                 prop = prop->getNextElement())
            {
                const auto attrName = prop->getStringAttribute ("name");
                if (attrName == "INote")
                    inNote = juce::jlimit (0, 127, prop->getIntAttribute ("value"));
                else if (attrName == "ONote")
                    outNote = juce::jlimit (0, 127, prop->getIntAttribute ("value"));
                else if (attrName == "Channel")
                    cubaseCh = prop->getIntAttribute ("value");
                else if (attrName == "Name")
                    name = prop->getStringAttribute ("value").trim();
            }

            // Cubase channel: -1/-2 = any/keep, else 0-based → 1-based
            const int channel = cubaseCh < 0 ? 0 : juce::jlimit (1, 16, cubaseCh + 1);
            addEntry (out, name, inNote, 0, outNote, channel);
            if (inNote >= 0 && outNote >= 0 && ! name.isEmpty())
                sawValid = true;
        }
    }

    if (! sawValid)
        out.entries.clear();
    return sawValid;
}

} // namespace pme
