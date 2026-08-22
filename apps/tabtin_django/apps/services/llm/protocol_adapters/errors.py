class ProtocolAdapterError(ValueError): pass
class ModelProtocolNotConfigured(ProtocolAdapterError): pass
class UnsupportedProtocolType(ProtocolAdapterError): pass
class ProtocolAdapterUnavailable(ProtocolAdapterError): pass
class DuplicateProtocolAdapter(ProtocolAdapterError): pass
class FrozenProtocolRegistry(ProtocolAdapterError): pass
class ProtocolContractError(ProtocolAdapterError): pass
