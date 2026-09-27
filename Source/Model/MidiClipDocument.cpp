#include "MidiClipDocument.h"
#include "../Util/VarUtil.h"

namespace pme
{

const Note* DocumentSnapshot::findNote (juce::uint32 id) const
{
    for (const auto& n : notes)
        if (n.id == id)
            return &n;
    return nullptr;
}

const ArticulationDef* DocumentSnapshot::findArticulation (juce::uint32 id) const
{
    for (const auto& a : articulations)
        if (a.id == id)
            return &a;
    return nullptr;
}

const ControllerEvent* DocumentSnapshot::findCc (juce::uint32 id) const
{
    for (const auto& e : ccs)
        if (e.id == id)
            return &e;
    return nullptr;
}

const PitchBendEvent* DocumentSnapshot::findPb (juce::uint32 id) const
{
    for (const auto& e : pbs)
        if (e.id == id)
            return &e;
    return nullptr;
}

const ChordEvent* DocumentSnapshot::findChord (juce::uint32 id) const
{
    for (const auto& e : chords)
        if (e.id == id)
            return &e;
    return nullptr;
}

//==============================================================================
void MidiClipDocument::beginTransaction (juce::String name)
{
    jassert (pendingTransaction.empty());
    pendingTransaction = {};
}

void MidiClipDocument::commitTransaction()
{
    if (pendingTransaction.empty())
        return;
    transactions.resize (undoIndex);
    transactions.push_back (std::move (pendingTransaction));
    undoIndex = transactions.size();
    pendingTransaction.clear();
    if (onDocumentChanged)
        onDocumentChanged();
}

void MidiClipDocument::cancelTransaction()
{
    for (auto it = pendingTransaction.rbegin(); it != pendingTransaction.rend(); ++it)
        apply (*it, false);
    pendingTransaction.clear();
    publish();
}

juce::uint32 MidiClipDocument::addNote (Note n)
{
    n.id = nextId++;
    Op o; o.kind = Op::Kind::add; o.type = Op::Type::note; o.noteAfter = n;
    apply (o, true);
    record (o);
    return n.id;
}

void MidiClipDocument::updateNotes (const std::vector<Note>& updated)
{
    for (auto u : updated)
    {
        auto it = notes.find (u.id);
        if (it == notes.end())
            continue;
        Op o; o.kind = Op::Kind::update; o.type = Op::Type::note;
        o.noteBefore = it->second; o.noteAfter = u;
        apply (o, true);
        record (o);
    }
}

void MidiClipDocument::removeNotes (const std::vector<juce::uint32>& ids)
{
    for (auto id : ids)
    {
        auto it = notes.find (id);
        if (it == notes.end())
            continue;
        Op o; o.kind = Op::Kind::remove; o.type = Op::Type::note;
        o.noteBefore = it->second;
        apply (o, true);
        record (o);
    }
}

juce::uint32 MidiClipDocument::addCC (ControllerEvent e)
{
    e.id = nextId++;
    Op o; o.kind = Op::Kind::add; o.type = Op::Type::cc; o.ccAfter = e;
    apply (o, true);
    record (o);
    return e.id;
}

void MidiClipDocument::updateCCs (const std::vector<ControllerEvent>& updated)
{
    for (auto u : updated)
    {
        auto it = ccs.find (u.id);
        if (it == ccs.end())
            continue;
        Op o; o.kind = Op::Kind::update; o.type = Op::Type::cc;
        o.ccBefore = it->second; o.ccAfter = u;
        apply (o, true);
        record (o);
    }
}

void MidiClipDocument::removeCCs (const std::vector<juce::uint32>& ids)
{
    for (auto id : ids)
    {
        auto it = ccs.find (id);
        if (it == ccs.end())
            continue;
        Op o; o.kind = Op::Kind::remove; o.type = Op::Type::cc;
        o.ccBefore = it->second;
        apply (o, true);
        record (o);
    }
}

juce::uint32 MidiClipDocument::addPitchBend (PitchBendEvent e)
{
    e.id = nextId++;
    Op o; o.kind = Op::Kind::add; o.type = Op::Type::pb; o.pbAfter = e;
    apply (o, true);
    record (o);
    return e.id;
}

void MidiClipDocument::updatePitchBends (const std::vector<PitchBendEvent>& updated)
{
    for (auto u : updated)
    {
        auto it = pbs.find (u.id);
        if (it == pbs.end())
            continue;
        Op o; o.kind = Op::Kind::update; o.type = Op::Type::pb;
        o.pbBefore = it->second; o.pbAfter = u;
        apply (o, true);
        record (o);
    }
}

void MidiClipDocument::removePitchBends (const std::vector<juce::uint32>& ids)
{
    for (auto id : ids)
    {
        auto it = pbs.find (id);
        if (it == pbs.end())
            continue;
        Op o; o.kind = Op::Kind::remove; o.type = Op::Type::pb;
        o.pbBefore = it->second;
        apply (o, true);
        record (o);
    }
}

juce::uint32 MidiClipDocument::addChord (ChordEvent e)
{
    e.id = nextId++;
    Op o; o.kind = Op::Kind::add; o.type = Op::Type::chord; o.chordAfter = e;
    apply (o, true);
    record (o);
    return e.id;
}

void MidiClipDocument::updateChords (const std::vector<ChordEvent>& updated)
{
    for (auto u : updated)
    {
        auto it = chords.find (u.id);
        if (it == chords.end())
            continue;
        Op o; o.kind = Op::Kind::update; o.type = Op::Type::chord;
        o.chordBefore = it->second; o.chordAfter = u;
        apply (o, true);
        record (o);
    }
}

void MidiClipDocument::removeChords (const std::vector<juce::uint32>& ids)
{
    for (auto id : ids)
    {
        auto it = chords.find (id);
        if (it == chords.end())
            continue;
        Op o; o.kind = Op::Kind::remove; o.type = Op::Type::chord;
        o.chordBefore = it->second;
        apply (o, true);
        record (o);
    }
}

void MidiClipDocument::setArticulations (const std::vector<ArticulationDef>& arts)
{
    articulations = arts;
    publish();
}

void MidiClipDocument::apply (const Op& op, bool forward)
{
    switch (op.type)
    {
        case Op::Type::note:
        {
            switch (op.kind)
            {
                case Op::Kind::add:
                    if (forward) notes[op.noteAfter.id] = op.noteAfter;
                    else notes.erase (op.noteAfter.id);
                    break;
                case Op::Kind::remove:
                    if (forward) notes.erase (op.noteBefore.id);
                    else notes[op.noteBefore.id] = op.noteBefore;
                    break;
                case Op::Kind::update:
                    notes[op.noteAfter.id] = forward ? op.noteAfter : op.noteBefore;
                    break;
            }
            break;
        }
        case Op::Type::cc:
        {
            switch (op.kind)
            {
                case Op::Kind::add:
                    if (forward) ccs[op.ccAfter.id] = op.ccAfter;
                    else ccs.erase (op.ccAfter.id);
                    break;
                case Op::Kind::remove:
                    if (forward) ccs.erase (op.ccBefore.id);
                    else ccs[op.ccBefore.id] = op.ccBefore;
                    break;
                case Op::Kind::update:
                    ccs[op.ccAfter.id] = forward ? op.ccAfter : op.ccBefore;
                    break;
            }
            break;
        }
        case Op::Type::pb:
        {
            switch (op.kind)
            {
                case Op::Kind::add:
                    if (forward) pbs[op.pbAfter.id] = op.pbAfter;
                    else pbs.erase (op.pbAfter.id);
                    break;
                case Op::Kind::remove:
                    if (forward) pbs.erase (op.pbBefore.id);
                    else pbs[op.pbBefore.id] = op.pbBefore;
                    break;
                case Op::Kind::update:
                    pbs[op.pbAfter.id] = forward ? op.pbAfter : op.pbBefore;
                    break;
            }
            break;
        }
        case Op::Type::chord:
        {
            switch (op.kind)
            {
                case Op::Kind::add:
                    if (forward) chords[op.chordAfter.id] = op.chordAfter;
                    else chords.erase (op.chordAfter.id);
                    break;
                case Op::Kind::remove:
                    if (forward) chords.erase (op.chordBefore.id);
                    else chords[op.chordBefore.id] = op.chordBefore;
                    break;
                case Op::Kind::update:
                    chords[op.chordAfter.id] = forward ? op.chordAfter : op.chordBefore;
                    break;
            }
            break;
        }
    }
}

void MidiClipDocument::record (Op op)
{
    pendingTransaction.push_back (std::move (op));
    publish();
}

void MidiClipDocument::undo()
{
    if (! canUndo())
        return;
    for (auto it = transactions[undoIndex - 1].rbegin(); it != transactions[undoIndex - 1].rend(); ++it)
        apply (*it, false);
    --undoIndex;
    publish();
    if (onDocumentChanged)
        onDocumentChanged();
}

void MidiClipDocument::redo()
{
    if (! canRedo())
        return;
    for (const auto& op : transactions[undoIndex])
        apply (op, true);
    ++undoIndex;
    publish();
    if (onDocumentChanged)
        onDocumentChanged();
}

void MidiClipDocument::clear()
{
    std::vector<juce::uint32> noteIds, ccIds, pbIds, chordIds;
    noteIds.reserve (notes.size());
    ccIds.reserve (ccs.size());
    pbIds.reserve (pbs.size());
    chordIds.reserve (chords.size());
    for (auto& [id, n] : notes) noteIds.push_back (id);
    for (auto& [id, e] : ccs)   ccIds.push_back (id);
    for (auto& [id, e] : pbs)   pbIds.push_back (id);
    for (auto& [id, e] : chords) chordIds.push_back (id);
    removeNotes (noteIds);
    removeCCs (ccIds);
    removePitchBends (pbIds);
    removeChords (chordIds);
}

void MidiClipDocument::publish()
{
    auto s = std::make_shared<DocumentSnapshot>();
    s->revision = snapshot.load()->revision + 1;
    s->notes.reserve (notes.size());
    for (const auto& [id, n] : notes)
        s->notes.push_back (n);
    std::sort (s->notes.begin(), s->notes.end(), [] (const Note& a, const Note& b)
    {
        if (a.start != b.start)
            return a.start < b.start;
        return a.id < b.id;
    });
    s->ccs.reserve (ccs.size());
    for (const auto& [id, e] : ccs)
        s->ccs.push_back (e);
    std::sort (s->ccs.begin(), s->ccs.end(), [] (const ControllerEvent& a, const ControllerEvent& b)
    {
        if (a.ppq != b.ppq)
            return a.ppq < b.ppq;
        return a.id < b.id;
    });
    s->pbs.reserve (pbs.size());
    for (const auto& [id, e] : pbs)
        s->pbs.push_back (e);
    std::sort (s->pbs.begin(), s->pbs.end(), [] (const PitchBendEvent& a, const PitchBendEvent& b)
    {
        if (a.ppq != b.ppq)
            return a.ppq < b.ppq;
        return a.id < b.id;
    });
    s->chords.reserve (chords.size());
    for (const auto& [id, e] : chords)
        s->chords.push_back (e);
    std::sort (s->chords.begin(), s->chords.end(), [] (const ChordEvent& a, const ChordEvent& b)
    {
        if (a.start != b.start)
            return a.start < b.start;
        return a.id < b.id;
    });
    s->articulations = articulations;
    snapshot.store (std::move (s));
}

//==============================================================================
juce::var MidiClipDocument::snapshotToJson (const DocumentSnapshot& s)
{
    auto doc = new juce::DynamicObject();
    doc->setProperty ("revision", (double) s.revision);

    juce::Array<juce::var> arr;
    arr.ensureStorageAllocated ((int) s.notes.size());
    for (const auto& n : s.notes)
    {
        auto o = new juce::DynamicObject();
        o->setProperty ("id", (double) n.id);
        o->setProperty ("p", n.pitch);
        o->setProperty ("s", n.start);
        o->setProperty ("l", n.length);
        o->setProperty ("v", juce::var (n.velocity));
        o->setProperty ("m", n.muted);
        o->setProperty ("c", n.channel);
        o->setProperty ("a", n.art);
        arr.add (juce::var (o));
    }
    doc->setProperty ("notes", arr);

    juce::Array<juce::var> ccArr;
    ccArr.ensureStorageAllocated ((int) s.ccs.size());
    for (const auto& e : s.ccs)
    {
        auto o = new juce::DynamicObject();
        o->setProperty ("id", (double) e.id);
        o->setProperty ("cc", e.cc);
        o->setProperty ("c", e.channel);
        o->setProperty ("t", e.ppq);
        o->setProperty ("v", e.value);
        ccArr.add (juce::var (o));
    }
    // NOTE: keys must match frontend/src/bridge/protocol.ts (ccs / pbs).
    doc->setProperty ("ccs", ccArr);

    juce::Array<juce::var> pbArr;
    pbArr.ensureStorageAllocated ((int) s.pbs.size());
    for (const auto& e : s.pbs)
    {
        auto o = new juce::DynamicObject();
        o->setProperty ("id", (double) e.id);
        o->setProperty ("c", e.channel);
        o->setProperty ("t", e.ppq);
        o->setProperty ("v", e.value);
        pbArr.add (juce::var (o));
    }
    doc->setProperty ("pbs", pbArr);

    juce::Array<juce::var> chordArr;
    chordArr.ensureStorageAllocated ((int) s.chords.size());
    for (const auto& e : s.chords)
    {
        auto o = new juce::DynamicObject();
        o->setProperty ("id", (double) e.id);
        o->setProperty ("s", e.start);
        o->setProperty ("l", e.length);
        o->setProperty ("r", e.root);
        o->setProperty ("q", e.quality);
        chordArr.add (juce::var (o));
    }
    doc->setProperty ("chords", chordArr);

    juce::Array<juce::var> artArr;
    artArr.ensureStorageAllocated ((int) s.articulations.size());
    for (const auto& a : s.articulations)
    {
        auto o = new juce::DynamicObject();
        o->setProperty ("id", (double) a.id);
        o->setProperty ("n", a.name);
        o->setProperty ("ks", a.keyswitch);
        o->setProperty ("cc", a.cc);
        o->setProperty ("v", a.ccValue);
        artArr.add (juce::var (o));
    }
    doc->setProperty ("articulations", artArr);

    return juce::var (doc);
}

juce::var MidiClipDocument::toVar() const
{
    juce::uint32 maxId = 0;
    juce::Array<juce::var> arr;
    for (const auto& [id, n] : notes)
    {
        auto o = new juce::DynamicObject();
        o->setProperty ("id", (double) n.id);
        o->setProperty ("p", n.pitch);
        o->setProperty ("s", n.start);
        o->setProperty ("l", n.length);
        o->setProperty ("v", juce::var (n.velocity));
        o->setProperty ("m", n.muted);
        o->setProperty ("c", n.channel);
        o->setProperty ("a", n.art);
        arr.add (juce::var (o));
        maxId = juce::jmax (maxId, id);
    }
    juce::Array<juce::var> ccArr;
    for (const auto& [id, e] : ccs)
    {
        auto o = new juce::DynamicObject();
        o->setProperty ("id", (double) e.id);
        o->setProperty ("cc", e.cc);
        o->setProperty ("c", e.channel);
        o->setProperty ("t", e.ppq);
        o->setProperty ("v", e.value);
        ccArr.add (juce::var (o));
        maxId = juce::jmax (maxId, id);
    }
    juce::Array<juce::var> pbArr;
    for (const auto& [id, e] : pbs)
    {
        auto o = new juce::DynamicObject();
        o->setProperty ("id", (double) e.id);
        o->setProperty ("c", e.channel);
        o->setProperty ("t", e.ppq);
        o->setProperty ("v", e.value);
        pbArr.add (juce::var (o));
        maxId = juce::jmax (maxId, id);
    }
    juce::Array<juce::var> chordArr;
    for (const auto& [id, e] : chords)
    {
        auto o = new juce::DynamicObject();
        o->setProperty ("id", (double) e.id);
        o->setProperty ("s", e.start);
        o->setProperty ("l", e.length);
        o->setProperty ("r", e.root);
        o->setProperty ("q", e.quality);
        chordArr.add (juce::var (o));
        maxId = juce::jmax (maxId, id);
    }
    juce::Array<juce::var> artArr;
    for (const auto& a : articulations)
    {
        auto o = new juce::DynamicObject();
        o->setProperty ("id", (double) a.id);
        o->setProperty ("n", a.name);
        o->setProperty ("ks", a.keyswitch);
        o->setProperty ("cc", a.cc);
        o->setProperty ("v", a.ccValue);
        artArr.add (juce::var (o));
    }
    auto doc = new juce::DynamicObject();
    doc->setProperty ("nextId", (double) maxId + 1);
    doc->setProperty ("notes", arr);
    doc->setProperty ("cc", ccArr);
    doc->setProperty ("pb", pbArr);
    doc->setProperty ("chords", chordArr);
    doc->setProperty ("articulations", artArr);
    return juce::var (doc);
}

void MidiClipDocument::loadFromVar (const juce::var& v)
{
    notes.clear();
    ccs.clear();
    pbs.clear();
    chords.clear();
    articulations.clear();
    transactions.clear();
    pendingTransaction.clear();
    undoIndex = 0;
    nextId = 1;

    auto* o = v.getDynamicObject();
    if (o == nullptr)
    {
        publish();
        return;
    }

    auto bumpMax = [this] (double idVal) -> juce::uint32
    {
        auto id = (juce::uint32) idVal;
        if (id == 0)
            id = nextId++;
        nextId = juce::jmax (nextId, id + 1);
        return id;
    };

    if (auto* arr = o->getProperty ("notes").getArray())
    {
        for (auto& nv : *arr)
        {
            auto* no = nv.getDynamicObject();
            if (no == nullptr)
                continue;
            Note n;
            n.id = bumpMax (propNum (*no, "id"));
            n.pitch = (int) propNum (*no, "p", 60.0);
            n.start = propNum (*no, "s");
            n.length = propNum (*no, "l", 0.25);
            n.velocity = (float) propNum (*no, "v", 0.8);
            n.muted = propBool (*no, "m");
            n.channel = (int) propNum (*no, "c", 1.0);
            n.art = (int) propNum (*no, "a", -1.0);
            notes[n.id] = n;
        }
    }
    if (auto* arr = o->getProperty ("cc").getArray())
    {
        for (auto& ev : *arr)
        {
            auto* eo = ev.getDynamicObject();
            if (eo == nullptr)
                continue;
            ControllerEvent e;
            e.id = bumpMax (propNum (*eo, "id"));
            e.cc = (int) propNum (*eo, "cc", 11.0);
            e.channel = (int) propNum (*eo, "c", 1.0);
            e.ppq = propNum (*eo, "t");
            e.value = (int) propNum (*eo, "v");
            ccs[e.id] = e;
        }
    }
    if (auto* arr = o->getProperty ("pb").getArray())
    {
        for (auto& ev : *arr)
        {
            auto* eo = ev.getDynamicObject();
            if (eo == nullptr)
                continue;
            PitchBendEvent e;
            e.id = bumpMax (propNum (*eo, "id"));
            e.channel = (int) propNum (*eo, "c", 1.0);
            e.ppq = propNum (*eo, "t");
            e.value = (int) propNum (*eo, "v", 8192.0);
            pbs[e.id] = e;
        }
    }
    if (auto* arr = o->getProperty ("chords").getArray())
    {
        for (auto& ev : *arr)
        {
            auto* eo = ev.getDynamicObject();
            if (eo == nullptr)
                continue;
            ChordEvent e;
            e.id = bumpMax (propNum (*eo, "id"));
            e.start = propNum (*eo, "s");
            e.length = propNum (*eo, "l", 1.0);
            e.root = (int) propNum (*eo, "r");
            e.quality = (int) propNum (*eo, "q");
            chords[e.id] = e;
        }
    }
    if (auto* arr = o->getProperty ("articulations").getArray())
    {
        for (auto& av : *arr)
        {
            auto* ao = av.getDynamicObject();
            if (ao == nullptr)
                continue;
            ArticulationDef a;
            a.id = (juce::uint32) propNum (*ao, "id");
            a.name = propStr (*ao, "n");
            a.keyswitch = (int) propNum (*ao, "ks", -1.0);
            a.cc = (int) propNum (*ao, "cc", -1.0);
            a.ccValue = (int) propNum (*ao, "v");
            articulations.push_back (a);
        }
    }

    // legacy saves without nextId: keep counter ahead of everything
    nextId = juce::jmax (nextId, (juce::uint32) propNum (*o, "nextId", 1.0));
    publish();
}

} // namespace pme
