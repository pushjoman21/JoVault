//! Trusted-image checkpoint experiment. Never accept attacker images.
use boa_engine::builtins::promise::PromiseState;
use boa_engine::context::time::FixedClock;
use boa_engine::job::SimpleJobExecutor;
use boa_engine::module::MapModuleLoader;
use boa_engine::property::PropertyKey;
use boa_engine::{Context, JsNativeError, JsResult, JsValue, Module, Script, Source, js_string};
use serde::Deserialize;
use std::collections::BTreeSet;
use std::fmt::Write;
use std::path::Path;
use std::rc::Rc;

const MAX_INPUT_BYTES: usize = 64 * 1024 * 1024;
const MAX_MODULES: usize = 128;
const MAX_GLOBAL_SCRIPTS: usize = 16;
const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESULT_UNITS: usize = 8192;
const MAX_ARGUMENTS: usize = 64;
const MAX_ARGUMENT_BYTES: usize = 4 * 1024 * 1024;
const MAX_EXPORT_NAMES: usize = 256;
const MAX_METADATA_BYTES: usize = 256 * 1024;
const MAX_ERROR_BYTES: usize = 8192;
#[cfg(feature = "instruction-budget")]
const INSTRUCTION_BUDGET: usize = 200_000;

fn diagnostic(error: impl std::fmt::Display) -> String {
    let mut text = format!("{error}");
    if text.len() > MAX_ERROR_BYTES {
        let mut boundary = MAX_ERROR_BYTES;
        while !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        text.truncate(boundary);
    }
    text
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GraphInput<'a> {
    format: String,
    entry: String,
    #[serde(borrow)]
    modules: Vec<ModuleInput<'a>>,
    #[serde(
        default,
        borrow,
        rename = "globalScripts",
        deserialize_with = "present_global_scripts"
    )]
    global_scripts: Option<Vec<ModuleInput<'a>>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModuleInput<'a> {
    id: String,
    #[serde(borrow)]
    source: &'a serde_json::value::RawValue,
}

fn present_global_scripts<'de: 'a, 'a, D>(
    deserializer: D,
) -> Result<Option<Vec<ModuleInput<'a>>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // Missing is None via default; an explicit null must not alias an absent field.
    Vec::<ModuleInput<'a>>::deserialize(deserializer).map(Some)
}

fn canonical_id(id: &str) -> bool {
    id.len() >= 2
        && id.len() <= 1024
        && id.starts_with('/')
        && id[1..].split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        })
}

fn graph_input(bytes: &[u8]) -> JsResult<GraphInput<'_>> {
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(JsNativeError::typ().with_message("INPUT_SIZE").into());
    }
    // Struct deserialization rejects duplicate fields as well as unknown fields.
    std::str::from_utf8(bytes).map_err(|_| JsNativeError::typ().with_message("INPUT_UTF8"))?;
    let graph: GraphInput<'_> = serde_json::from_slice(bytes)
        .map_err(|_| JsNativeError::typ().with_message("INPUT_SCHEMA"))?;
    let compatible = match graph.format.as_str() {
        // INPUT0 retains its original schema: even an empty new field is rejected.
        "JOVLT-BOA-INPUT0" => graph.global_scripts.is_none(),
        "JOVLT-BOA-INPUT1" => graph.global_scripts.is_some(),
        _ => false,
    };
    let global_count = graph.global_scripts.as_ref().map_or(0, Vec::len);
    if !compatible
        || global_count > MAX_GLOBAL_SCRIPTS
        || graph.modules.len() + global_count > MAX_MODULES
        || !canonical_id(&graph.entry)
        || graph.modules.is_empty()
        || graph.modules.len() > MAX_MODULES
    {
        return Err(JsNativeError::typ().with_message("INPUT_SCHEMA").into());
    }
    let mut ids = BTreeSet::new();
    for module in &graph.modules {
        if !canonical_id(&module.id) || !ids.insert(module.id.as_str()) {
            return Err(JsNativeError::typ().with_message("INPUT_SCHEMA").into());
        }
    }
    if !ids.contains(graph.entry.as_str()) {
        return Err(JsNativeError::typ().with_message("INPUT_ENTRY").into());
    }
    for script in graph.global_scripts.iter().flatten() {
        if !canonical_id(&script.id) || !ids.insert(script.id.as_str()) {
            return Err(JsNativeError::typ().with_message("INPUT_SCHEMA").into());
        }
    }
    Ok(graph)
}

fn decode_source(raw: &serde_json::value::RawValue) -> JsResult<String> {
    let raw = raw.get().as_bytes();
    let invalid = || JsNativeError::typ().with_message("INPUT_SOURCE");
    if raw.len() < 2 || raw[0] != b'"' || raw[raw.len() - 1] != b'"' {
        return Err(invalid().into());
    }
    // RawValue borrows JSON source without serde's plaintext string scratch copy.
    // One preallocated output avoids reallocations leaving old source prefixes.
    let mut output = Vec::with_capacity(raw.len().min(MAX_SOURCE_BYTES + 1));
    let mut cursor = 1;
    while cursor < raw.len() - 1 {
        if raw[cursor] != b'\\' {
            output.push(raw[cursor]);
            cursor += 1;
        } else {
            cursor += 1;
            match raw[cursor] {
                b'"' | b'\\' | b'/' => output.push(raw[cursor]),
                b'b' => output.push(8),
                b'f' => output.push(12),
                b'n' => output.push(b'\n'),
                b'r' => output.push(b'\r'),
                b't' => output.push(b'\t'),
                b'u' => {
                    let unit = std::str::from_utf8(&raw[cursor + 1..cursor + 5])
                        .ok()
                        .and_then(|hex| u16::from_str_radix(hex, 16).ok())
                        .ok_or_else(invalid)?;
                    cursor += 4;
                    let codepoint = if (0xd800..=0xdbff).contains(&unit) {
                        if raw.get(cursor + 1..cursor + 3) != Some(b"\\u".as_slice()) {
                            return Err(invalid().into());
                        }
                        let low = std::str::from_utf8(
                            raw.get(cursor + 3..cursor + 7).ok_or_else(invalid)?,
                        )
                        .ok()
                        .and_then(|hex| u16::from_str_radix(hex, 16).ok())
                        .filter(|low| (0xdc00..=0xdfff).contains(low))
                        .ok_or_else(invalid)?;
                        cursor += 6;
                        0x10000 + ((u32::from(unit) - 0xd800) << 10) + u32::from(low) - 0xdc00
                    } else {
                        u32::from(unit)
                    };
                    let character = char::from_u32(codepoint).ok_or_else(invalid)?;
                    let mut bytes = [0; 4];
                    output.extend_from_slice(character.encode_utf8(&mut bytes).as_bytes());
                }
                _ => return Err(invalid().into()),
            }
            cursor += 1;
        }
        if output.len() > MAX_SOURCE_BYTES {
            return Err(JsNativeError::typ()
                .with_message("INPUT_SOURCE_SIZE")
                .into());
        }
    }
    String::from_utf8(output).map_err(|_| invalid().into())
}

fn wipe_source(source: String) {
    let mut bytes = source.into_bytes();
    let source_len = bytes.len();
    bytes.resize(bytes.capacity(), 0);
    for byte in &mut bytes {
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
    unsafe {
        SOURCE_BUFFERS_WIPED += 1;
        SOURCE_BYTES_WIPED += source_len as u32;
        SOURCE_CAPACITY_WIPED += bytes.len() as u32;
    }
}

enum Compiled {
    Script(Script),
    Module(Module),
}
struct Root {
    context: Context,
    compiled: Compiled,
    global_scripts: Vec<Script>,
    globals_initialized: bool,
    globals_failed: bool,
}
static mut ROOT: *mut Root = std::ptr::null_mut();
static mut COMPILE_CALLS: u32 = 0;
static mut EXECUTE_CALLS: u32 = 0;
static mut ERROR: Option<String> = None;
static mut FAILURE_JSON: Option<&'static str> = None;
static mut RESULT: Option<String> = None;
static mut SOURCE_BUFFERS_WIPED: u32 = 0;
static mut SOURCE_BYTES_WIPED: u32 = 0;
static mut SOURCE_CAPACITY_WIPED: u32 = 0;
static mut LINKED_MODULE_ROOTS: u32 = 0;
static mut GLOBAL_SCRIPT_EVALUATIONS: u32 = 0;

fn record_failure(error: boa_engine::JsError) {
    #[cfg(feature = "instruction-budget")]
    let exhausted = matches!(
        error.as_engine(),
        Some(boa_engine::error::EngineError::NoInstructionsRemain)
    );
    #[cfg(not(feature = "instruction-budget"))]
    let exhausted = false;
    unsafe {
        FAILURE_JSON = Some(if exhausted {
            "{\"ok\":false,\"error\":{\"code\":\"instruction_budget_exhausted\"}}"
        } else {
            "{\"ok\":false,\"error\":{\"code\":\"execution_failed\"}}"
        });
        ERROR = Some(diagnostic(error));
    }
}

fn require_fuel(_context: &Context) -> JsResult<()> {
    #[cfg(feature = "instruction-budget")]
    if _context.instructions_remaining() == 0 {
        return Err(boa_engine::error::EngineError::NoInstructionsRemain.into());
    }
    Ok(())
}

#[link(wasm_import_module = "probe")]
unsafe extern "C" {
    fn entropy(ptr: *mut u8, len: usize);
}

#[unsafe(no_mangle)]
unsafe extern "Rust" fn __getrandom_v03_custom(
    ptr: *mut u8,
    len: usize,
) -> Result<(), getrandom::Error> {
    // getrandom may pass uninitialized memory. Initialize it before exposing a
    // host byte view; the trusted entropy import must then fill every byte.
    unsafe { std::ptr::write_bytes(ptr, 0, len) };
    unsafe { entropy(ptr, len) };
    Ok(())
}

fn settled_value(state: PromiseState) -> JsResult<JsValue> {
    match state {
        PromiseState::Fulfilled(value) => Ok(value),
        PromiseState::Rejected(error) => Err(boa_engine::JsError::from_opaque(error)),
        PromiseState::Pending => Err(JsNativeError::typ()
            .with_message("probe requires a settled promise at the ABI boundary")
            .into()),
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc_input(len: usize) -> *mut u8 {
    if len > MAX_INPUT_BYTES {
        return std::ptr::null_mut();
    }
    // Leak one input allocation deliberately; host zeros it before snapshot.
    Box::into_raw(vec![0_u8; len].into_boxed_slice()).cast()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn compile_source(ptr: *const u8, len: usize, module: u32) -> u32 {
    unsafe {
        COMPILE_CALLS += 1;
        ERROR = None;
        FAILURE_JSON = None;
        RESULT = None;
        ROOT = std::ptr::null_mut();
        GLOBAL_SCRIPT_EVALUATIONS = 0;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let result = (|| -> JsResult<Root> {
        let builder = Context::builder()
            .clock(Rc::new(FixedClock::default()))
            .job_executor(Rc::new(SimpleJobExecutor::new()))
            .module_loader(Rc::new(boa_engine::module::IdleModuleLoader));
        #[cfg(feature = "source-removal")]
        let builder = builder.retain_source_text(false);
        #[cfg(feature = "instruction-budget")]
        let builder = builder.instructions_remaining(INSTRUCTION_BUDGET);
        let mut context = builder.build()?;
        context
            .runtime_limits_mut()
            .set_loop_iteration_limit(100_000);
        context.runtime_limits_mut().set_recursion_limit(128);
        let compiled = if module != 0 {
            let module = Module::parse(Source::from_bytes(bytes), None, &mut context)?;
            let promise = module.load(&mut context);
            context.run_jobs()?;
            settled_value(promise.state())?;
            module.link(&mut context)?;
            Compiled::Module(module)
        } else {
            let script = Script::parse(Source::from_bytes(bytes), None, &mut context)?;
            script.codeblock(&mut context)?;
            Compiled::Script(script)
        };
        Ok(Root {
            context,
            compiled,
            global_scripts: Vec::new(),
            globals_initialized: true,
            globals_failed: false,
        })
    })();
    match result {
        Ok(root) => {
            let ptr = Box::into_raw(Box::new(root));
            unsafe { ROOT = ptr };
            ptr as u32
        }
        Err(error) => {
            record_failure(error);
            0
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn compile_graph(ptr: *const u8, len: usize) -> u32 {
    unsafe {
        COMPILE_CALLS += 1;
        ERROR = None;
        FAILURE_JSON = None;
        RESULT = None;
        ROOT = std::ptr::null_mut();
        SOURCE_BUFFERS_WIPED = 0;
        SOURCE_BYTES_WIPED = 0;
        SOURCE_CAPACITY_WIPED = 0;
        LINKED_MODULE_ROOTS = 0;
        GLOBAL_SCRIPT_EVALUATIONS = 0;
    }
    if len > MAX_INPUT_BYTES || ptr.is_null() {
        unsafe { ERROR = Some("INPUT_SIZE".to_owned()) };
        return 0;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let result = (|| -> JsResult<Root> {
        let graph = graph_input(bytes)?;
        let loader = Rc::new(MapModuleLoader::new());
        let builder = Context::builder()
            .clock(Rc::new(FixedClock::default()))
            .job_executor(Rc::new(SimpleJobExecutor::new()))
            .module_loader(loader.clone());
        #[cfg(feature = "source-removal")]
        let builder = builder.retain_source_text(false);
        #[cfg(feature = "instruction-budget")]
        let builder = builder.instructions_remaining(INSTRUCTION_BUDGET);
        let mut context = builder.build()?;
        context
            .runtime_limits_mut()
            .set_loop_iteration_limit(100_000);
        context.runtime_limits_mut().set_recursion_limit(128);
        let mut entry = None;
        let mut registered = Vec::with_capacity(graph.modules.len());
        let mut source_bytes = 0;
        let mut global_scripts = Vec::new();
        for input in graph.global_scripts.into_iter().flatten() {
            let owned_source = decode_source(input.source)?;
            source_bytes += owned_source.len();
            if source_bytes > MAX_TOTAL_SOURCE_BYTES {
                wipe_source(owned_source);
                return Err(JsNativeError::typ().with_message("INPUT_SIZE").into());
            }
            // Preserve original Script strictness and global declaration semantics.
            // Compile before snapshot; evaluate only after restoration, before modules.
            let parsed: JsResult<Script> = (|| {
                let source = Source::from_bytes(&owned_source).with_path(Path::new(&input.id));
                let script = Script::parse(source, None, &mut context)?;
                script.codeblock(&mut context)?;
                Ok(script)
            })();
            wipe_source(owned_source);
            global_scripts.push(parsed?);
        }
        for input in graph.modules {
            let owned_source = decode_source(input.source)?;
            source_bytes += owned_source.len();
            if source_bytes > MAX_TOTAL_SOURCE_BYTES {
                wipe_source(owned_source);
                return Err(JsNativeError::typ().with_message("INPUT_SIZE").into());
            }
            let source = Source::from_bytes(&owned_source).with_path(Path::new(&input.id));
            let parsed = Module::parse(source, None, &mut context);
            wipe_source(owned_source);
            let module = parsed?;
            if input.id == graph.entry {
                entry = Some(module.clone());
            }
            registered.push(module.clone());
            loader.insert(&input.id, module);
        }
        let module = entry.ok_or_else(|| JsNativeError::typ().with_message("INPUT_ENTRY"))?;
        // Include dynamic-only registrations: no registered module is left unlinked.
        for registered_module in &registered {
            let promise = registered_module.load(&mut context);
            context.run_jobs()?;
            settled_value(promise.state())?;
        }
        for registered_module in &registered {
            registered_module.link(&mut context)?;
            unsafe { LINKED_MODULE_ROOTS += 1 };
        }
        Ok(Root {
            context,
            compiled: Compiled::Module(module),
            globals_initialized: global_scripts.is_empty(),
            globals_failed: false,
            global_scripts,
        })
    })();
    match result {
        Ok(root) => {
            let ptr = Box::into_raw(Box::new(root));
            unsafe { ROOT = ptr };
            ptr as u32
        }
        Err(error) => {
            record_failure(error);
            0
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn source_buffers_wiped() -> u32 {
    unsafe { SOURCE_BUFFERS_WIPED }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn source_bytes_wiped() -> u32 {
    unsafe { SOURCE_BYTES_WIPED }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn source_capacity_wiped() -> u32 {
    unsafe { SOURCE_CAPACITY_WIPED }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn linked_module_roots() -> u32 {
    unsafe { LINKED_MODULE_ROOTS }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn compiled_global_scripts() -> u32 {
    if unsafe { ROOT.is_null() } {
        return 0;
    }
    unsafe { (&*ROOT).global_scripts.len() as u32 }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn global_script_evaluations() -> u32 {
    unsafe { GLOBAL_SCRIPT_EVALUATIONS }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn global_scripts_initialized() -> u32 {
    if unsafe { ROOT.is_null() } {
        return 0;
    }
    u32::from(unsafe { (&*ROOT).globals_initialized })
}

#[unsafe(no_mangle)]
pub extern "C" fn source_retention_disabled() -> u32 {
    u32::from(cfg!(feature = "source-removal"))
}

#[unsafe(no_mangle)]
pub extern "C" fn instruction_budget_enabled() -> u32 {
    u32::from(cfg!(feature = "instruction-budget"))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn remaining_instructions() -> u32 {
    #[cfg(feature = "instruction-budget")]
    {
        if unsafe { ROOT.is_null() } {
            return 0;
        }
        let root = unsafe { &*ROOT };
        return root.context.instructions_remaining() as u32;
    }
    #[cfg(not(feature = "instruction-budget"))]
    {
        0
    }
}

fn evaluate_root(root: &mut Root, args: &[JsValue]) -> JsResult<JsValue> {
    // Reject another entry before module setup, property access or native calls.
    require_fuel(&root.context)?;
    if root.globals_failed {
        return Err(JsNativeError::typ()
            .with_message("GLOBAL_SCRIPT_INITIALIZATION_FAILED")
            .into());
    }
    if !root.globals_initialized {
        // Any abrupt completion makes this instance unusable: never replay a prefix.
        root.globals_failed = true;
        for script in &root.global_scripts {
            require_fuel(&root.context)?;
            unsafe { GLOBAL_SCRIPT_EVALUATIONS += 1 };
            script.evaluate(&mut root.context)?;
            require_fuel(&root.context)?;
            root.context.run_jobs()?;
            require_fuel(&root.context)?;
        }
        root.globals_initialized = true;
        root.globals_failed = false;
    }
    match &root.compiled {
        Compiled::Script(script) => script.evaluate(&mut root.context),
        Compiled::Module(module) => {
            let promise = module.evaluate(&mut root.context)?;
            require_fuel(&root.context)?;
            root.context.run_jobs()?;
            settled_value(promise.state())?;
            let main = module.get_value(js_string!("main"), &mut root.context)?;
            let callable = main.as_callable().ok_or_else(|| {
                JsNativeError::typ().with_message("fixture must export a callable main")
            })?;
            require_fuel(&root.context)?;
            let value = callable.call(&JsValue::undefined(), args, &mut root.context)?;
            require_fuel(&root.context)?;
            root.context.run_jobs()?;
            if let Some(object) = value.as_object() {
                if let Ok(promise) = boa_engine::object::builtins::JsPromise::from_object(object) {
                    settled_value(promise.state())
                } else {
                    Ok(value)
                }
            } else {
                Ok(value)
            }
        }
    }
}

fn argument_string(raw: &serde_json::value::RawValue) -> JsResult<JsValue> {
    let raw = raw.get().as_bytes();
    let invalid = || JsNativeError::typ().with_message("ARGUMENT_STRING");
    if raw.len() < 2 || raw[0] != b'"' || raw[raw.len() - 1] != b'"' {
        return Err(invalid().into());
    }
    let mut units = Vec::with_capacity(raw.len().min(MAX_RESULT_UNITS + 1));
    let mut cursor = 1;
    while cursor < raw.len() - 1 {
        if raw[cursor] == b'\\' {
            cursor += 1;
            let unit = match raw[cursor] {
                b'"' | b'\\' | b'/' => u16::from(raw[cursor]),
                b'b' => 8,
                b'f' => 12,
                b'n' => 10,
                b'r' => 13,
                b't' => 9,
                b'u' => {
                    let unit = raw
                        .get(cursor + 1..cursor + 5)
                        .and_then(|hex| std::str::from_utf8(hex).ok())
                        .and_then(|hex| u16::from_str_radix(hex, 16).ok())
                        .ok_or_else(invalid)?;
                    cursor += 4;
                    unit
                }
                _ => return Err(invalid().into()),
            };
            // UTF-16 units intentionally include unpaired escaped surrogates.
            units.push(unit);
            cursor += 1;
        } else {
            let end = raw[cursor..raw.len() - 1]
                .iter()
                .position(|byte| *byte == b'\\')
                .map_or(raw.len() - 1, |offset| cursor + offset);
            let text = std::str::from_utf8(&raw[cursor..end]).map_err(|_| invalid())?;
            for unit in text.encode_utf16() {
                units.push(unit);
                if units.len() > MAX_RESULT_UNITS {
                    return Err(JsNativeError::typ()
                        .with_message("ARGUMENT_STRING_SIZE")
                        .into());
                }
            }
            cursor = end;
        }
        if units.len() > MAX_RESULT_UNITS {
            return Err(JsNativeError::typ()
                .with_message("ARGUMENT_STRING_SIZE")
                .into());
        }
    }
    Ok(JsValue::from(boa_engine::JsString::from(units.as_slice())))
}

struct BoundedArguments<'a>(Vec<&'a serde_json::value::RawValue>);

impl<'de> Deserialize<'de> for BoundedArguments<'de> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ArgumentVisitor;
        impl<'de> serde::de::Visitor<'de> for ArgumentVisitor {
            type Value = BoundedArguments<'de>;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a bounded argument array")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let mut arguments = Vec::with_capacity(MAX_ARGUMENTS);
                while let Some(argument) =
                    sequence.next_element::<&'de serde_json::value::RawValue>()?
                {
                    if arguments.len() == MAX_ARGUMENTS {
                        return Err(serde::de::Error::custom("ARGUMENT_COUNT"));
                    }
                    arguments.push(argument);
                }
                Ok(BoundedArguments(arguments))
            }
        }
        deserializer.deserialize_seq(ArgumentVisitor)
    }
}

fn primitive_arguments(bytes: &[u8]) -> JsResult<Vec<JsValue>> {
    if bytes.len() > MAX_ARGUMENT_BYTES {
        return Err(JsNativeError::typ().with_message("ARGUMENT_BYTES").into());
    }
    std::str::from_utf8(bytes).map_err(|_| JsNativeError::typ().with_message("ARGUMENT_UTF8"))?;
    let raw: BoundedArguments<'_> = serde_json::from_slice(bytes).map_err(|error| {
        let code = if error.to_string().starts_with("ARGUMENT_COUNT") {
            "ARGUMENT_COUNT"
        } else {
            "ARGUMENT_JSON"
        };
        JsNativeError::typ().with_message(code)
    })?;
    raw.0
        .into_iter()
        .map(|argument| match argument.get() {
            "null" => Ok(JsValue::null()),
            "true" => Ok(JsValue::from(true)),
            "false" => Ok(JsValue::from(false)),
            text if text.starts_with('"') => argument_string(argument),
            text if text.starts_with('-')
                || text.as_bytes().first().is_some_and(u8::is_ascii_digit) =>
            {
                let number: f64 = serde_json::from_str(text)
                    .map_err(|_| JsNativeError::typ().with_message("ARGUMENT_NUMBER"))?;
                if !number.is_finite() {
                    return Err(JsNativeError::typ().with_message("ARGUMENT_NUMBER").into());
                }
                Ok(JsValue::from(number))
            }
            _ => Err(JsNativeError::typ()
                .with_message("ARGUMENT_UNSUPPORTED")
                .into()),
        })
        .collect()
}

fn json_string(string: &boa_engine::JsString) -> JsResult<String> {
    if string.len() > MAX_RESULT_UNITS {
        return Err(JsNativeError::typ().with_message("RESULT_SIZE").into());
    }
    let mut encoded = String::from("\"");
    // Escape code units directly so lone surrogates survive the JSON boundary.
    for unit in string.iter() {
        write!(&mut encoded, "\\u{unit:04x}")
            .map_err(|_| JsNativeError::typ().with_message("RESULT_ENCODING"))?;
    }
    encoded.push('"');
    Ok(encoded)
}

fn primitive_result(value: JsValue) -> JsResult<String> {
    if value.is_undefined() {
        return Ok("{\"type\":\"undefined\"}".to_owned());
    }
    if value.is_null() {
        return Ok("{\"type\":\"null\"}".to_owned());
    }
    if let Some(boolean) = value.as_boolean() {
        return Ok(format!("{{\"type\":\"boolean\",\"value\":{boolean}}}"));
    }
    if let Some(number) = value.as_number() {
        let encoded = if number.is_nan() {
            "\"NaN\"".to_owned()
        } else if number == f64::INFINITY {
            "\"Infinity\"".to_owned()
        } else if number == f64::NEG_INFINITY {
            "\"-Infinity\"".to_owned()
        } else if number == 0.0 && number.is_sign_negative() {
            "\"-0\"".to_owned()
        } else {
            serde_json::to_string(&number)
                .map_err(|_| JsNativeError::typ().with_message("RESULT_ENCODING"))?
        };
        return Ok(format!("{{\"type\":\"number\",\"value\":{encoded}}}"));
    }
    if let Some(string) = value.as_string() {
        return Ok(format!(
            "{{\"type\":\"string\",\"value\":{}}}",
            json_string(&string)?
        ));
    }
    Err(JsNativeError::typ()
        .with_message("RESULT_UNSUPPORTED")
        .into())
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn export_names_json() -> u32 {
    unsafe {
        ERROR = None;
        FAILURE_JSON = None;
        RESULT = None;
        if ROOT.is_null() {
            ERROR = Some("no compiled root has been installed".to_owned());
            return 0;
        }
    }
    let root = unsafe { &mut *ROOT };
    let result = (|| -> JsResult<String> {
        let Compiled::Module(module) = &root.compiled else {
            return Ok("[]".to_owned());
        };
        // Namespace key enumeration does not read or initialize exported bindings.
        let keys = module
            .namespace(&mut root.context)
            .own_property_keys(&mut root.context)?;
        let mut result = String::from("[");
        let mut count = 0;
        for key in keys {
            let name = match key {
                PropertyKey::String(name) => name,
                PropertyKey::Index(index) => js_string!(index.get().to_string().as_str()),
                PropertyKey::Symbol(_) => continue,
            };
            count += 1;
            if count > MAX_EXPORT_NAMES {
                return Err(JsNativeError::typ()
                    .with_message("EXPORT_NAMES_SIZE")
                    .into());
            }
            if count > 1 {
                result.push(',');
            }
            result.push_str(&json_string(&name)?);
            if result.len() >= MAX_METADATA_BYTES {
                return Err(JsNativeError::typ()
                    .with_message("EXPORT_NAMES_SIZE")
                    .into());
            }
        }
        result.push(']');
        Ok(result)
    })();
    match result {
        Ok(result) => {
            unsafe { RESULT = Some(result) };
            1
        }
        Err(error) => {
            record_failure(error);
            0
        }
    }
}

fn invoke_json_values(args: JsResult<Vec<JsValue>>) -> u32 {
    unsafe {
        EXECUTE_CALLS += 1;
        ERROR = None;
        FAILURE_JSON = None;
        RESULT = None;
        if ROOT.is_null() {
            ERROR = Some("no compiled root has been installed".to_owned());
            return 0;
        }
    }
    let root = unsafe { &mut *ROOT };
    match args
        .and_then(|args| evaluate_root(root, &args))
        .and_then(primitive_result)
    {
        Ok(result) => {
            unsafe { RESULT = Some(result) };
            1
        }
        Err(error) => {
            record_failure(error);
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn invoke_json() -> u32 {
    invoke_json_values(Ok(Vec::new()))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn invoke_json_args(ptr: *const u8, len: usize) -> u32 {
    let args = if len > MAX_ARGUMENT_BYTES || ptr.is_null() {
        Err(JsNativeError::typ().with_message("ARGUMENT_BYTES").into())
    } else {
        primitive_arguments(unsafe { std::slice::from_raw_parts(ptr, len) })
    };
    invoke_json_values(args)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn invoke_compiled() -> f64 {
    unsafe {
        EXECUTE_CALLS += 1;
        ERROR = None;
        FAILURE_JSON = None;
        RESULT = None;
        if ROOT.is_null() {
            ERROR = Some("no compiled root has been installed".to_owned());
            return f64::NAN;
        }
    }
    let root = unsafe { &mut *ROOT };
    let result = evaluate_root(root, &[]).and_then(|value| value.to_number(&mut root.context));
    match result {
        Ok(value) => value,
        Err(error) => {
            record_failure(error);
            f64::NAN
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn compile_calls() -> u32 {
    unsafe { COMPILE_CALLS }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn execute_calls() -> u32 {
    unsafe { EXECUTE_CALLS }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn root_pointer() -> u32 {
    unsafe { ROOT as u32 }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn guest_marker() -> u32 {
    if unsafe { ROOT.is_null() } {
        return 0;
    }
    let root = unsafe { &mut *ROOT };
    root.context
        .global_object()
        .get(js_string!("__executed"), &mut root.context)
        .map_or(0, |value| {
            value
                .as_number()
                .map_or_else(|| u32::from(!value.is_undefined()), |number| number as u32)
        })
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn error_ptr() -> *const u8 {
    unsafe {
        (&*std::ptr::addr_of!(ERROR))
            .as_ref()
            .map_or(std::ptr::null(), |e| e.as_ptr())
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn error_len() -> usize {
    unsafe {
        (&*std::ptr::addr_of!(ERROR))
            .as_ref()
            .map_or(0, |e| e.len())
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn error_json_ptr() -> *const u8 {
    unsafe {
        (&*std::ptr::addr_of!(FAILURE_JSON))
            .as_ref()
            .map_or(std::ptr::null(), |error| error.as_ptr())
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn error_json_len() -> usize {
    unsafe {
        (&*std::ptr::addr_of!(FAILURE_JSON))
            .as_ref()
            .map_or(0, |error| error.len())
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn result_ptr() -> *const u8 {
    unsafe {
        (&*std::ptr::addr_of!(RESULT))
            .as_ref()
            .map_or(std::ptr::null(), |result| result.as_ptr())
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn result_len() -> usize {
    unsafe {
        (&*std::ptr::addr_of!(RESULT))
            .as_ref()
            .map_or(0, |result| result.len())
    }
}
