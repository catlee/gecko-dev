/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 4 -*-
 * vim: set ts=8 sts=4 et sw=4 tw=99:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gc/ZoneGroup.h"

#include "jscntxt.h"

#include "jit/IonBuilder.h"
#include "jit/JitCompartment.h"

namespace js {

ZoneGroup::ZoneGroup(JSRuntime* runtime)
  : runtime(runtime),
    ownerContext_(TlsContext.get()),
    enterCount(1),
    zones_(this),
    usedByHelperThread(false),
#ifdef DEBUG
    ionBailAfter_(this, 0),
#endif
    jitZoneGroup(this, nullptr),
    debuggerList_(this),
    ionLazyLinkListSize_(0)
{}

bool
ZoneGroup::init()
{
    AutoLockGC lock(runtime);

    jitZoneGroup = js_new<jit::JitZoneGroup>(this);
    if (!jitZoneGroup)
        return false;

    return true;
}

ZoneGroup::~ZoneGroup()
{
#ifdef DEBUG
    {
        AutoLockHelperThreadState lock;
        MOZ_ASSERT(ionLazyLinkListSize_ == 0);
        MOZ_ASSERT(ionLazyLinkList().isEmpty());
    }
#endif

    js_delete(jitZoneGroup.ref());

    if (this == runtime->gc.systemZoneGroup)
        runtime->gc.systemZoneGroup = nullptr;
}

void
ZoneGroup::enter()
{
    JSContext* cx = TlsContext.get();
    if (ownerContext().context() == cx) {
        MOZ_ASSERT(enterCount);
    } else {
        MOZ_RELEASE_ASSERT(ownerContext().context() == nullptr);
        MOZ_ASSERT(enterCount == 0);
        ownerContext_ = CooperatingContext(cx);
        if (cx->generationalDisabled)
            nursery().disable();
    }
    enterCount++;
}

void
ZoneGroup::leave()
{
    MOZ_ASSERT(ownedByCurrentThread());
    MOZ_ASSERT(enterCount);
    if (--enterCount == 0)
        ownerContext_ = CooperatingContext(nullptr);
}

bool
ZoneGroup::ownedByCurrentThread()
{
    MOZ_ASSERT(TlsContext.get());
    return ownerContext().context() == TlsContext.get();
}

ZoneGroup::IonBuilderList&
ZoneGroup::ionLazyLinkList()
{
    MOZ_ASSERT(CurrentThreadCanAccessRuntime(runtime),
               "Should only be mutated by the active thread.");
    return ionLazyLinkList_.ref();
}

void
ZoneGroup::ionLazyLinkListRemove(jit::IonBuilder* builder)
{
    MOZ_ASSERT(CurrentThreadCanAccessRuntime(runtime),
               "Should only be mutated by the active thread.");
    MOZ_ASSERT(ionLazyLinkListSize_ > 0);

    builder->removeFrom(ionLazyLinkList());
    ionLazyLinkListSize_--;

    MOZ_ASSERT(ionLazyLinkList().isEmpty() == (ionLazyLinkListSize_ == 0));
}

void
ZoneGroup::ionLazyLinkListAdd(jit::IonBuilder* builder)
{
    MOZ_ASSERT(CurrentThreadCanAccessRuntime(runtime),
               "Should only be mutated by the active thread.");
    ionLazyLinkList().insertFront(builder);
    ionLazyLinkListSize_++;
}

} // namespace js
