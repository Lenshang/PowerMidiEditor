#pragma once

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_core/juce_core.h>
#include "../Model/MidiClipDocument.h"

namespace pme
{

// Standard MIDI file import/export. Timing uses 480 ticks per quarter note;
// document times are in quarter notes, so conversion is exact for the grid
// values a user can draw.
class MidiFileIO
{
public:
    struct ImportResult
    {
        std::vector<Note> notes;
        std::vector<ControllerEvent> ccs;
        std::vector<PitchBendEvent> pbs;
        double tempoBpm = 120.0;             // earliest tempo meta in the file
    };

    static bool exportMidi (const DocumentSnapshot& snapshot, const juce::File& file);
    static bool importMidi (const juce::File& file, ImportResult& out);
    static bool importMidiFromMemory (const void* data, size_t numBytes, ImportResult& out);

private:
    static bool importFromStream (juce::InputStream& stream, ImportResult& out);
};

} // namespace pme
