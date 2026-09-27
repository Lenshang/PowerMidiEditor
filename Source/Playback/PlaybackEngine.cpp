#include "PlaybackEngine.h"

namespace pme
{

PlaybackEngine::PlaybackEngine()
{
    activeNotes.reserve (64);
    auditionNotes.reserve (64);
    previews.reserve (16);
    for (auto& a : currentArt)
        a = -1;
    resetCurveState();
    tickScratch.reserve (256);
    ccHasPrev.assign (16 * 128, 0);
    ccHasNext.assign (16 * 128, 0);
    ccPrevT.assign (16 * 128, 0.0);
    ccNextT.assign (16 * 128, 0.0);
    ccPrevV.assign (16 * 128, 0);
    ccNextV.assign (16 * 128, 0);
}

//==============================================================================
// Command queue (message thread -> audio thread)
bool PlaybackEngine::pushCmd (const Cmd& c)
{
    auto w = cmdWrite.load (std::memory_order_relaxed);
    auto r = cmdRead.load (std::memory_order_acquire);
    auto next = (w + 1) % cmdCapacity;
    if (next == r)
        return false; // full: drop, realtime path must never block
    cmdRing[w] = c;
    cmdWrite.store (next, std::memory_order_release);
    return true;
}

void PlaybackEngine::drainCmds()
{
    auto r = cmdRead.load (std::memory_order_relaxed);
    auto w = cmdWrite.load (std::memory_order_acquire);
    while (r != w)
    {
        const auto& c = cmdRing[r];
        switch (c.type)
        {
            case CmdType::auditionStart:
                auditionActive = true;
                auditionCursor = c.ppq;
                auditionNotes.clear();
                break;
            case CmdType::auditionStop:
                auditionActive = false;
                auditionStopRequested = true; // flush sounding notes in render()
                break;
            case CmdType::previewNote:
            {
                PreviewNote on { c.pitch, c.channel,
                                 engineSampleCounter + (juce::int64) (0.35 * currentSampleRate),
                                 c.velocity };
                previewNoteOns.push_back (on);  // note-on emitted in render()
                previews.push_back (on);        // note-off scheduled
                break;
            }
            case CmdType::panic:
                panicRequested = true; // flushed in render() where we have the buffer
                break;
            case CmdType::internalPlay:
                internalPlaying = true;
                internalStarted = true;
                internalCursor = c.ppq;
                internalFlagForUi.store (true, std::memory_order_relaxed);
                break;
            case CmdType::internalStop:
                internalPlaying = false;
                internalFlagForUi.store (false, std::memory_order_relaxed);
                internalStopRequested = true; // notes flushed in render()
                break;
        }
        r = (r + 1) % cmdCapacity;
    }
    cmdRead.store (r, std::memory_order_release);
}

//==============================================================================
// Message-thread controls
void PlaybackEngine::startAudition (double startPpq)
{
    pushCmd ({ CmdType::auditionStart, startPpq, 0, 1, 0.0f });
    auditionFlagForUi.store (true, std::memory_order_relaxed);
}

void PlaybackEngine::stopAudition()
{
    pushCmd ({ CmdType::auditionStop, 0.0, 0, 1, 0.0f });
    auditionFlagForUi.store (false, std::memory_order_relaxed);
}

void PlaybackEngine::previewNote (int pitch, int channel, float velocity)
{
    pushCmd ({ CmdType::previewNote, 0.0, pitch, channel, velocity });
}

void PlaybackEngine::panic()
{
    pushCmd ({ CmdType::panic, 0.0, 0, 1, 0.0f });
    auditionFlagForUi.store (false, std::memory_order_relaxed);
}

void PlaybackEngine::startInternal (double startPpq)
{
    pushCmd ({ CmdType::internalPlay, startPpq, 0, 1, 0.0f });
    internalFlagForUi.store (true, std::memory_order_relaxed);
}

void PlaybackEngine::stopInternal()
{
    pushCmd ({ CmdType::internalStop, 0.0, 0, 1, 0.0f });
    internalFlagForUi.store (false, std::memory_order_relaxed);
}

//==============================================================================
int PlaybackEngine::sampleOffsetFor (double ppq, double anchorPpq, const EngineInputs& in) const
{
    const double pps = lastPpqPerSample; // ppq per sample
    if (pps <= 0.0)
        return 0;
    return juce::jlimit (0, in.numSamples - 1, (int) juce::roundToInt ((ppq - anchorPpq) / pps));
}

void PlaybackEngine::flushNotes (juce::MidiBuffer& out, std::vector<ActiveNote>& list, int sampleOffset)
{
    for (const auto& a : list)
        out.addEvent (juce::MidiMessage::noteOff (a.channel, a.pitch), sampleOffset);
    list.clear();
}

// Schedule everything in [fromPpq, toPpq) onto out.
// anchorPpq is the ppq at blockStartSample of this segment.
void PlaybackEngine::playRange (juce::MidiBuffer& out, const EngineInputs& in,
                                double fromPpq, double toPpq, double anchorPpq,
                                int blockStartSample, std::vector<ActiveNote>& active, bool chase)
{
    if (! (toPpq > fromPpq) || in.snapshot == nullptr)
        return;

    const auto& notes = in.snapshot->notes;

    // -- note-offs for notes already sounding -------------------------------
    for (size_t i = 0; i < active.size();)
    {
        const auto& a = active[i];
        if (a.endPpq >= fromPpq && a.endPpq < toPpq)
        {
            out.addEvent (juce::MidiMessage::noteOff (a.channel, a.pitch),
                          blockStartSample + sampleOffsetFor (a.endPpq, anchorPpq, in));
            active.erase (active.begin() + i);
        }
        else
        {
            ++i;
        }
    }

    // -- note-ons ------------------------------------------------------------
    auto first = std::lower_bound (notes.begin(), notes.end(), fromPpq,
                                   [] (const Note& n, double t) { return n.start < t; });

    if (chase && fromPpq > 0.0)
    {
        // Notes that started before the cursor but are still sounding.
        for (auto it = notes.begin(); it != first; ++it)
        {
            if (it->start + it->length > fromPpq)
            {
                out.addEvent (juce::MidiMessage::noteOn (it->channel, it->pitch, it->velocity),
                              blockStartSample);
                active.push_back ({ it->id, it->pitch, it->channel, it->start + it->length });
            }
            if (it->start + it->length <= fromPpq)
                break; // sorted by start: earlier notes cannot still sound
        }
    }

    for (auto it = first; it != notes.end() && it->start < toPpq; ++it)
    {
        if (it->muted || it->length <= 0.0)
            continue;
        double end = it->start + it->length;
        int offset = blockStartSample + sampleOffsetFor (it->start, anchorPpq, in);

        // expression map: inject keyswitch / CC when the articulation changes
        if (it->art >= 0)
        {
            const auto* art = in.snapshot->findArticulation ((juce::uint32) it->art);
            const int ch = juce::jlimit (1, 16, it->channel) - 1;
            if (art != nullptr && currentArt[ch] != (int) it->art)
            {
                currentArt[ch] = (int) it->art;
                if (art->keyswitch >= 0)
                {
                    out.addEvent (juce::MidiMessage::noteOn (it->channel, art->keyswitch, 1.0f), offset);
                    out.addEvent (juce::MidiMessage::noteOff (it->channel, art->keyswitch),
                                  juce::jmin (offset + 256, in.numSamples - 1));
                }
                if (art->cc >= 0)
                    out.addEvent (juce::MidiMessage::controllerEvent (it->channel, art->cc, art->ccValue), offset);
            }
        }

        out.addEvent (juce::MidiMessage::noteOn (it->channel, it->pitch, it->velocity), offset);
        active.push_back ({ it->id, it->pitch, it->channel, end });
    }

    // -- controller + pitch bend curves ---------------------------------------
    // Points are the knots of piecewise-linear ramps (DAW automation style):
    // the engine samples the ramps at a fine grid and emits on value change.
    playCurves (out, in, fromPpq, toPpq, anchorPpq, blockStartSample);
}

void PlaybackEngine::resetCurveState() noexcept
{
    for (auto& v : lastPbSent)
        v = -1;
    for (auto& row : lastCcSent)
        for (auto& v : row)
            v = -1;
}

void PlaybackEngine::resetCurvesToNeutral (juce::MidiBuffer& out)
{
    for (int ch = 0; ch < 16; ++ch)
    {
        if (lastPbSent[ch] >= 0 && lastPbSent[ch] != 8192)
        {
            out.addEvent (juce::MidiMessage::pitchWheel (ch + 1, 8192), 0);
            lastPbSent[ch] = 8192;
        }
        for (int cc = 0; cc < 128; ++cc)
        {
            if (lastCcSent[ch][cc] >= 0 && lastCcSent[ch][cc] != 0)
            {
                out.addEvent (juce::MidiMessage::controllerEvent (ch + 1, cc, 0), 0);
                lastCcSent[ch][cc] = 0;
            }
        }
    }
}

void PlaybackEngine::playCurves (juce::MidiBuffer& out, const EngineInputs& in,
                                 double fromPpq, double toPpq, double anchorPpq,
                                 int blockStartSample)
{
    if (! (toPpq > fromPpq) || in.snapshot == nullptr)
        return;
    const auto& ccs = in.snapshot->ccs;
    const auto& pbs = in.snapshot->pbs;
    if (ccs.empty() && pbs.empty())
        return;

    // Sample times: a fine global grid (1/64 ppq ≈ 8 ms at 120 bpm) so ramps
    // are continuous, plus the exact knot times so jumps land on the sample.
    tickScratch.clear();
    const constexpr double step = 1.0 / 64.0;
    const int firstTick = (int) std::ceil (fromPpq / step - 1e-9);
    const int lastTick = (int) std::floor ((toPpq - 1e-9) / step);
    for (int k = firstTick; k <= lastTick; ++k)
        tickScratch.push_back ((double) k * step);
    for (const auto& e : ccs)
        if (e.ppq >= fromPpq && e.ppq < toPpq)
            tickScratch.push_back (e.ppq);
    for (const auto& e : pbs)
        if (e.ppq >= fromPpq && e.ppq < toPpq)
            tickScratch.push_back (e.ppq);
    if (tickScratch.empty())
        return;
    std::sort (tickScratch.begin(), tickScratch.end());
    tickScratch.erase (std::unique (tickScratch.begin(), tickScratch.end(),
                                    [] (double a, double b) { return b - a < 1e-9; }),
                       tickScratch.end());

    for (const double t : tickScratch)
    {
        const int offset = blockStartSample + sampleOffsetFor (t, anchorPpq, in);

        // ---- pitch bend, per channel -------------------------------------
        if (! pbs.empty())
        {
            double prevT[16], nextT[16];
            int prevV[16], nextV[16];
            bool hasPrev[16] {}, hasNext[16] {};
            for (const auto& e : pbs)
            {
                const int ch = juce::jlimit (1, 16, e.channel) - 1;
                if (e.ppq <= t + 1e-9)
                {
                    if (! hasPrev[ch] || e.ppq >= prevT[ch])
                    {
                        prevT[ch] = e.ppq;
                        prevV[ch] = e.value;
                        hasPrev[ch] = true;
                    }
                }
                else if (! hasNext[ch] || e.ppq < nextT[ch])
                {
                    nextT[ch] = e.ppq;
                    nextV[ch] = e.value;
                    hasNext[ch] = true;
                }
            }
            for (int ch = 0; ch < 16; ++ch)
            {
                if (! hasPrev[ch] && ! hasNext[ch])
                    continue;
                int v;
                if (! hasPrev[ch])
                    v = 8192; // pitch bend rests at center before the first knot
                else if (! hasNext[ch])
                    v = prevV[ch]; // hold the last knot's value rightward
                else
                {
                    const double span = nextT[ch] - prevT[ch];
                    const double a = span > 1e-9 ? (t - prevT[ch]) / span : 0.0;
                    v = juce::roundToInt (prevV[ch] + (nextV[ch] - prevV[ch]) * juce::jlimit (0.0, 1.0, a));
                }
                v &= 0x3fff;
                if (v != lastPbSent[ch])
                {
                    lastPbSent[ch] = v;
                    out.addEvent (juce::MidiMessage::pitchWheel (ch + 1, v), offset);
                }
            }
        }

        // ---- controllers, per (channel, number) ---------------------------
        if (! ccs.empty())
        {
            std::fill (ccHasPrev.begin(), ccHasPrev.end(), (uint8_t) 0);
            std::fill (ccHasNext.begin(), ccHasNext.end(), (uint8_t) 0);
            for (const auto& e : ccs)
            {
                const int ch = juce::jlimit (1, 16, e.channel) - 1;
                const int num = juce::jlimit (0, 127, e.cc);
                const int idx = ch * 128 + num;
                if (e.ppq <= t + 1e-9)
                {
                    if (ccHasPrev[idx] == 0 || e.ppq >= ccPrevT[idx])
                    {
                        ccPrevT[idx] = e.ppq;
                        ccPrevV[idx] = e.value;
                        ccHasPrev[idx] = 1;
                    }
                }
                else if (ccHasNext[idx] == 0 || e.ppq < ccNextT[idx])
                {
                    ccNextT[idx] = e.ppq;
                    ccNextV[idx] = e.value;
                    ccHasNext[idx] = 1;
                }
            }
            for (const auto& e : ccs)
            {
                const int ch = juce::jlimit (1, 16, e.channel) - 1;
                const int num = juce::jlimit (0, 127, e.cc);
                const int idx = ch * 128 + num;
                if (ccHasPrev[idx] == 0 && ccHasNext[idx] == 0)
                    continue;
                int v;
                if (ccHasPrev[idx] == 0)
                    v = 0; // controllers rest at 0 before the first knot
                else if (ccHasNext[idx] == 0)
                    v = ccPrevV[idx];
                else
                {
                    const double span = ccNextT[idx] - ccPrevT[idx];
                    const double a = span > 1e-9 ? (t - ccPrevT[idx]) / span : 0.0;
                    v = juce::roundToInt (ccPrevV[idx] + (ccNextV[idx] - ccPrevV[idx]) * juce::jlimit (0.0, 1.0, a));
                }
                v = juce::jlimit (0, 127, v);
                if (v != lastCcSent[ch][num])
                {
                    lastCcSent[ch][num] = v;
                    out.addEvent (juce::MidiMessage::controllerEvent (ch + 1, num, v), offset);
                }
            }
        }
    }
}

//==============================================================================
void PlaybackEngine::render (juce::MidiBuffer& out, const EngineInputs& in)
{
    currentSampleRate = in.sampleRate;
    lastPpqPerSample = (in.tempo / 60.0) / in.sampleRate; // ppq per sample
    engineSampleCounter += in.numSamples;

    drainCmds();

    if (panicRequested)
    {
        panicRequested = false;
        flushNotes (out, activeNotes, 0);
        flushNotes (out, auditionNotes, 0);
        flushNotes (out, internalNotes, 0);
        for (const auto& p : previews)
            out.addEvent (juce::MidiMessage::noteOff (p.channel, p.pitch), 0);
        previews.clear();
        previewNoteOns.clear();
        auditionActive = false;
    }

    // queued preview note-ons go out at the top of the block
    for (const auto& p : previewNoteOns)
        out.addEvent (juce::MidiMessage::noteOn (p.channel, p.pitch, p.velocity), 0);
    previewNoteOns.clear();

    const double blockPpq = (double) in.numSamples * lastPpqPerSample;

    // ---------------- transport-driven playback -----------------------------
    if (in.playing && in.ppqValid)
    {
        bool relocated = false;
        if (lastTimeValid && in.timeValid)
            relocated = in.timeInSamples != lastTimeInSamples + lastNumSamples;
        else if (cursorValid)
            relocated = std::abs (in.ppq - (cursor + blockPpq)) > 0.1;

        const bool freshStart = ! cursorValid || relocated || ! wasPlaying;
        if (freshStart)
        {
            // Kill anything left sounding from before the (re)start, then let
            // chase below re-fire notes that should still be sounding.
            flushNotes (out, activeNotes, 0);
            cursor = in.ppq;
            for (auto& a : currentArt)
                a = -1; // articulation state restarts with the transport
            resetCurveState(); // curves re-send their value at the new position
        }

        if (in.loopValid && in.loopEndPpq - in.loopStartPpq > 0.0
            && in.ppq >= in.loopStartPpq - 1e-9 && in.ppq < in.loopEndPpq)
        {
            // Playing inside the loop range.
            double segEnd = juce::jmin (in.ppq + blockPpq, in.loopEndPpq);
            playRange (out, in, cursor, segEnd, in.ppq, 0, activeNotes, freshStart);
            cursor = segEnd;

            if (in.ppq + blockPpq >= in.loopEndPpq)
            {
                // Loop wrap: cut sounding notes at the loop end, then continue
                // from the loop start with the remaining samples.
                int wrapSample = sampleOffsetFor (in.loopEndPpq, in.ppq, in);
                flushNotes (out, activeNotes, wrapSample);
                double remainPpq = (in.ppq + blockPpq) - in.loopEndPpq;
                if (remainPpq > 0.0)
                {
                    cursor = in.loopStartPpq;
                    playRange (out, in, cursor, cursor + remainPpq, in.loopStartPpq,
                               wrapSample, activeNotes, false);
                }
            }
        }
        else
        {
            playRange (out, in, cursor, in.ppq + blockPpq, in.ppq, 0, activeNotes, freshStart);
            cursor = in.ppq + blockPpq;
        }

        cursorValid = true;
    }
    else if (wasPlaying)
    {
        flushNotes (out, activeNotes, 0);
        cursorValid = false;
    }
    wasPlaying = in.playing;

    // ---------------- internal transport (the plugin's own play button) -----
    if (auditionStopRequested)
    {
        // Release of the audition tool (or transport stop): without this the
        // held notes would sound forever — nothing else schedules their offs.
        auditionStopRequested = false;
        flushNotes (out, auditionNotes, 0);
        resetCurvesToNeutral (out);
    }

    if (internalStopRequested)
    {
        internalStopRequested = false;
        flushNotes (out, internalNotes, 0);
        resetCurvesToNeutral (out);
    }

    if (internalPlaying && in.playing && in.ppqValid)
    {
        // the host transport took over: internal play would double the notes
        internalPlaying = false;
        internalFlagForUi.store (false, std::memory_order_relaxed);
        flushNotes (out, internalNotes, 0);
        resetCurvesToNeutral (out);
    }
    else if (internalPlaying)
    {
        const bool firstBlock = internalStarted;
        if (firstBlock)
        {
            internalStarted = false;
            flushNotes (out, internalNotes, 0);
            for (auto& a : currentArt)
                a = -1;
            resetCurveState();
        }

        // loop range: the host loop when available, otherwise content bounds
        double loopStart = 0.0, loopEnd = 4.0;
        if (in.loopValid && in.loopEndPpq - in.loopStartPpq > 0.01)
        {
            loopStart = in.loopStartPpq;
            loopEnd = in.loopEndPpq;
        }
        else if (in.snapshot != nullptr && ! in.snapshot->notes.empty())
        {
            double first = 1e9, last = 0.0;
            for (const auto& n : in.snapshot->notes)
            {
                if (n.muted)
                    continue;
                first = juce::jmin (first, n.start);
                last = juce::jmax (last, n.start + n.length);
            }
            if (last > first)
            {
                loopStart = juce::jmax (0.0, first - 0.25);
                loopEnd = last + 0.5;
            }
        }

        const double blockPpqI = (double) in.numSamples * lastPpqPerSample;
        const double segEnd = internalCursor + blockPpqI;
        if (segEnd < loopEnd)
        {
            playRange (out, in, internalCursor, segEnd, internalCursor, 0, internalNotes, firstBlock);
            internalCursor = segEnd;
        }
        else
        {
            playRange (out, in, internalCursor, loopEnd, internalCursor, 0, internalNotes, firstBlock);
            const int wrapSample = sampleOffsetFor (loopEnd, internalCursor, in);
            flushNotes (out, internalNotes, wrapSample);
            const double remain = segEnd - loopEnd;
            internalCursor = loopStart;
            if (remain > 0.0)
                playRange (out, in, loopStart, loopStart + remain, loopStart, wrapSample, internalNotes, false);
            internalCursor = loopStart + remain;
        }
        internalPpqForUi.store (internalCursor, std::memory_order_relaxed);
    }

    if (in.timeValid)
    {
        lastTimeInSamples = in.timeInSamples;
        lastNumSamples = in.numSamples; // recorded here so the relocation check
        lastTimeValid = true;           // above still compares the PREVIOUS block's size
    }
    else
    {
        lastTimeValid = false;
    }

    // ---------------- audition (scrub) playback -----------------------------
    if (auditionActive)
    {
        double segEnd = auditionCursor + blockPpq;
        playRange (out, in, auditionCursor, segEnd, auditionCursor, 0, auditionNotes,
                   auditionNotes.empty());
        auditionCursor = segEnd;
        auditionPpqForUi.store (auditionCursor, std::memory_order_relaxed);
    }

    // ---------------- one-shot preview notes --------------------------------
    for (size_t i = 0; i < previews.size();)
    {
        if (previews[i].endSample < engineSampleCounter)
        {
            out.addEvent (juce::MidiMessage::noteOff (previews[i].channel, previews[i].pitch), 0);
            previews.erase (previews.begin() + i);
        }
        else
        {
            ++i;
        }
    }
}

} // namespace pme
