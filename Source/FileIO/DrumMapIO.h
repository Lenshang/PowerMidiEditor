#pragma once

#include <juce_core/juce_core.h>

namespace pme
{

// Drum-kit note-name maps for drum mode:
//  - Ample Sound .bwdrm: CSV "Name,SourceNote,SourceChannel,TargetNote,TargetChannel"
//  - Cubase .drm: XML <DrumMap><list name="Map"><item>… INote/ONote/Name …
// Both sources name-pair two pitches (input + output), so parsing yields
// entries for both; the keyboard shows whichever pitch is drawn.
struct DrumMapEntry
{
    int note = -1;        // 0..127
    juce::String name;
};

struct DrumMapData
{
    juce::String mapName;
    std::vector<DrumMapEntry> entries;

    bool isValid() const noexcept { return ! entries.empty(); }
    juce::String nameFor (int note) const noexcept
    {
        for (const auto& e : entries)
            if (e.note == note)
                return e.name;
        return {};
    }
};

class DrumMapIO
{
public:
    static bool parse (const juce::File& file, DrumMapData& out);
    static bool parseBwdrm (const juce::String& text, DrumMapData& out);
    static bool parseCubaseDrm (const juce::String& xmlText, DrumMapData& out);
};

} // namespace pme
