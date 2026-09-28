#include "DrumMapIO.h"

namespace pme
{

namespace
{
    void addEntry (DrumMapData& out, int note, const juce::String& name)
    {
        if (note < 0 || note > 127 || name.trim().isEmpty())
            return;
        // keep first name per pitch; later duplicates don't override
        for (const auto& e : out.entries)
            if (e.note == note)
                return;
        out.entries.push_back ({ note, name.trim() });
    }
}

bool DrumMapIO::parse (const juce::File& file, DrumMapData& out)
{
    const auto text = file.loadFileAsString();
    out = {};
    const auto fileName = file.getFileName();

    if (text.trim().startsWith ("<"))
        out.mapName = fileName.upToLastOccurrenceOf (".", false, true);
    else
        out.mapName = fileName.upToLastOccurrenceOf (".", false, true);

    if (parseBwdrm (text, out))
        return true;
    out.entries.clear();
    if (parseCubaseDrm (text, out))
        return true;
    out = {};
    return false;
}

// "Name,SourceNote,SourceChannel,TargetNote,TargetChannel"
// (reference: PowerDrumMapper NoteMapping::fromCsvString)
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

        const int sourceNote = juce::jlimit (0, 127, tokens[1].getIntValue());
        const int targetNote = juce::jlimit (0, 127, tokens[3].getIntValue());
        const auto name = tokens[0].trim();
        if (name.isEmpty())
            continue;

        addEntry (out, sourceNote, name);
        addEntry (out, targetNote, name);
        sawValid = true;
    }

    if (! sawValid)
        out.entries.clear();
    return sawValid;
}

// Cubase drum map XML: <DrumMap><list name="Map"><item>…
// INote = input pitch, ONote = output pitch, Name = instrument name.
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

            int inNote = -1, outNote = -1;
            juce::String name;
            for (auto* prop = item->getFirstChildElement(); prop != nullptr;
                 prop = prop->getNextElement())
            {
                const auto attrName = prop->getStringAttribute ("name");
                if (attrName == "INote")
                    inNote = juce::jlimit (0, 127, prop->getIntAttribute ("value"));
                else if (attrName == "ONote")
                    outNote = juce::jlimit (0, 127, prop->getIntAttribute ("value"));
                else if (attrName == "Name")
                    name = prop->getStringAttribute ("value").trim();
            }

            if (name.isEmpty())
                continue;
            addEntry (out, inNote, name);
            addEntry (out, outNote, name);
            if (inNote >= 0 || outNote >= 0)
                sawValid = true;
        }
    }

    if (! sawValid)
        out.entries.clear();
    return sawValid;
}

} // namespace pme
