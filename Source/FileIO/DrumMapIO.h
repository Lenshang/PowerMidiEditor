#pragma once

#include <juce_core/juce_core.h>

namespace pme
{

// Drum-kit note REMAPPER for drum mode (PowerDrumMapper semantics):
//  - Ample Sound .bwdrm: CSV "Name,SourceNote,SourceCh,TargetNote,TargetCh"
//  - Cubase .drm: XML <DrumMap><list name="Map"><item>… INote/ONote/Channel/Name
// A hit drawn/played at inNote (channel matching inChannel, 0 = any) is sent
// downstream as outNote on outChannel (0 = keep the incoming channel).
struct DrumMapEntry
{
    juce::String name;
    int inNote = -1;     // 0..127 source key (what you draw/play)
    int inChannel = 0;   // 0 = match any incoming channel, else 1..16
    int outNote = -1;    // 0..127 target key (what the synth receives)
    int channel = 0;     // 0 = keep incoming channel, else 1..16
};

struct DrumMapData
{
    juce::String mapName;
    std::vector<DrumMapEntry> entries;

    bool isValid() const noexcept { return ! entries.empty(); }

    juce::String nameFor (int inNote) const noexcept
    {
        for (const auto& e : entries)
            if (e.inNote == inNote)
                return e.name;
        return {};
    }

    /** Remap a note/channel. Returns false when no rule matches. */
    bool remap (int inNote, int inChannel, int& outNote, int& outChannel) const noexcept
    {
        for (const auto& e : entries)
        {
            if (e.inNote != inNote)
                continue;
            if (e.inChannel != 0 && e.inChannel != inChannel)
                continue;
            outNote = e.outNote;
            outChannel = e.channel != 0 ? e.channel : inChannel;
            return true;
        }
        return false;
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
