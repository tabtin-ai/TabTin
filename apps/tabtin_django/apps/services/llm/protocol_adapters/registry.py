from threading import RLock
from .errors import *
from .types import ProtocolType

class ProtocolAdapterRegistry:
    def __init__(self): self._items = {}; self._frozen = False; self._lock = RLock()
    def register(self, adapter):
        with self._lock:
            if self._frozen: raise FrozenProtocolRegistry("protocol-registry-frozen")
            if adapter.protocol_type in self._items: raise DuplicateProtocolAdapter(adapter.protocol_type.value)
            self._items[adapter.protocol_type] = adapter
    def freeze(self):
        with self._lock: self._frozen = True
        return self
    def resolve(self, protocol_type):
        if protocol_type is None: raise ModelProtocolNotConfigured("model-protocol-not-configured")
        if not isinstance(protocol_type, ProtocolType): raise UnsupportedProtocolType(str(protocol_type))
        try: return self._items[protocol_type]
        except KeyError: raise ProtocolAdapterUnavailable(protocol_type.value) from None
    def registered_types(self): return tuple(sorted(self._items, key=lambda item: item.value))

def build_default_protocol_registry():
    from .openai_compatible import OpenAICompatibleProtocolAdapter
    registry = ProtocolAdapterRegistry(); registry.register(OpenAICompatibleProtocolAdapter()); return registry.freeze()
