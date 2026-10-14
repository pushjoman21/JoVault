//! Conservative checkpoint-state gate for the exact JoVault Boa probe image.
//! A pass covers this binary's state layout, not guest conformance or safe loading.
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::{env, fs, process::ExitCode};
use wasmparser::{
    ConstExpr, DataKind, ElementItems, ElementKind, Encoding, ExternalKind, Operator, Parser,
    Payload, RefType, TableInit, TypeRef, ValType, Validator,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

fn scalar(ty: ValType) -> bool {
    matches!(
        ty,
        ValType::I32 | ValType::I64 | ValType::F32 | ValType::F64
    )
}

fn expression(expr: ConstExpr<'_>) -> Result<Vec<String>> {
    let mut reader = expr.get_operators_reader();
    let mut ops = Vec::new();
    while !reader.eof() {
        ops.push(format!("{:?}", reader.read()?));
    }
    Ok(ops)
}

fn audit(bytes: &[u8]) -> Result<Value> {
    Validator::new().validate_all(bytes)?;
    let mut reasons = BTreeSet::<String>::new();
    let mut imports = Vec::new();
    let mut exports = Vec::new();
    let mut globals = Vec::new();
    let mut tables = Vec::new();
    let mut memories = Vec::new();
    let mut elements = Vec::new();
    let mut data = Vec::new();
    let mut types = Vec::new();
    let mut global_exports = BTreeMap::<u32, Vec<String>>::new();
    let mut global_writes = BTreeMap::<u32, u64>::new();
    let mut operator_counts = BTreeMap::<String, u64>::new();
    let mut rejected_operator_counts = BTreeMap::<String, u64>::new();
    let mut start = None;
    let mut imported_globals = 0_u32;
    let mut imported_tables = 0_u32;
    let mut imported_memories = 0_u32;
    let mut imported_functions = 0_u32;
    let mut defined_functions = 0_u32;
    let mut code_bodies = 0_u32;
    let mut instruction_count = 0_u64;

    for payload in Parser::new(0).parse_all(bytes) {
        match payload? {
            Payload::Version { encoding, .. } => {
                if encoding != Encoding::Module {
                    return Err("only a core WASM module is supported".into());
                }
            }
            Payload::TypeSection(reader) => {
                // This API rejects GC/continuation types instead of overlooking
                // live Wasm-managed objects outside linear memory.
                for ty in reader.into_iter_err_on_gc_types() {
                    let ty = ty?;
                    if !ty.params().iter().chain(ty.results()).copied().all(scalar) {
                        reasons.insert("non-scalar function signature requires review".into());
                    }
                    types.push(ty);
                }
            }
            Payload::ImportSection(reader) => {
                for import in reader {
                    let import = import?;
                    let (kind, detail) = match import.ty {
                        TypeRef::Func(index) => {
                            imported_functions += 1;
                            let ty = types
                                .get(index as usize)
                                .ok_or("invalid import type index")?;
                            if import.module != "probe"
                                || import.name != "entropy"
                                || ty.params() != [ValType::I32, ValType::I32]
                                || !ty.results().is_empty()
                            {
                                reasons.insert(format!(
                                    "unapproved function import {}.{}",
                                    import.module, import.name
                                ));
                            }
                            (
                                "function",
                                json!({"typeIndex": index, "parameters": format!("{:?}", ty.params()), "results": format!("{:?}", ty.results())}),
                            )
                        }
                        TypeRef::Global(ty) => {
                            imported_globals += 1;
                            reasons.insert("imported global state is not supported".into());
                            ("global", json!(format!("{ty:?}")))
                        }
                        TypeRef::Table(ty) => {
                            imported_tables += 1;
                            reasons.insert("imported table state is not supported".into());
                            ("table", json!(format!("{ty:?}")))
                        }
                        TypeRef::Memory(ty) => {
                            imported_memories += 1;
                            reasons.insert("imported memory state is not supported".into());
                            ("memory", json!(format!("{ty:?}")))
                        }
                        TypeRef::Tag(ty) => {
                            reasons.insert("imported exception tags require review".into());
                            ("tag", json!(format!("{ty:?}")))
                        }
                    };
                    imports.push(json!({"module": import.module, "name": import.name, "kind": kind, "type": detail}));
                }
            }
            Payload::FunctionSection(reader) => defined_functions = reader.count(),
            Payload::TableSection(reader) => {
                for table in reader {
                    let table = table?;
                    let index = imported_tables + tables.len() as u32;
                    if table.ty.shared
                        || table.ty.table64
                        || table.ty.element_type != RefType::FUNCREF
                    {
                        reasons.insert(format!(
                            "table {index} is not an unshared wasm32 funcref table"
                        ));
                    }
                    let init = match table.init {
                        TableInit::RefNull => json!({"mode": "null"}),
                        TableInit::Expr(expr) => {
                            reasons.insert(format!(
                                "table {index} has an unreviewed expression initializer"
                            ));
                            json!({"mode": "expression", "operators": expression(expr)?})
                        }
                    };
                    tables.push(json!({"index": index, "initialElements": table.ty.initial,
                        "maximumElements": table.ty.maximum, "shared": table.ty.shared,
                        "table64": table.ty.table64, "elementType": format!("{:?}", table.ty.element_type), "initializer": init}));
                }
            }
            Payload::MemorySection(reader) => {
                for memory in reader {
                    let memory = memory?;
                    let index = imported_memories + memories.len() as u32;
                    if memory.shared
                        || memory.memory64
                        || memory.page_size_log2.is_some()
                        || memory.maximum.is_none_or(|maximum| maximum > 1024)
                    {
                        reasons.insert(format!("memory {index} requires an unshared wasm32 layout with a maximum of at most 64 MiB"));
                    }
                    memories.push(json!({"index": index, "initialPages": memory.initial,
                        "maximumPages": memory.maximum, "shared": memory.shared,
                        "memory64": memory.memory64, "pageSizeLog2": memory.page_size_log2}));
                }
            }
            Payload::GlobalSection(reader) => {
                for global in reader {
                    let global = global?;
                    let index = imported_globals + globals.len() as u32;
                    if global.ty.shared || !scalar(global.ty.content_type) {
                        reasons.insert(format!(
                            "global {index} has an unsupported shared/reference/vector layout"
                        ));
                    }
                    globals.push(json!({"index": index, "mutable": global.ty.mutable,
                        "shared": global.ty.shared, "valueType": format!("{:?}", global.ty.content_type),
                        "initializerOperators": expression(global.init_expr)?}));
                }
            }
            Payload::ExportSection(reader) => {
                for export in reader {
                    let export = export?;
                    if export.kind == ExternalKind::Global {
                        global_exports
                            .entry(export.index)
                            .or_default()
                            .push(export.name.to_owned());
                    }
                    exports.push(json!({"name": export.name, "kind": format!("{:?}", export.kind), "index": export.index}));
                }
            }
            Payload::StartSection { func, .. } => {
                start = Some(func);
                reasons.insert("a start function requires a separate initialization audit".into());
            }
            Payload::ElementSection(reader) => {
                for element in reader {
                    let element = element?;
                    let index = elements.len();
                    let mode = match element.kind {
                        ElementKind::Active {
                            table_index,
                            offset_expr,
                        } => {
                            json!({"kind": "active", "tableIndex": table_index.unwrap_or(0), "offsetOperators": expression(offset_expr)?})
                        }
                        ElementKind::Passive => {
                            reasons.insert(format!("passive element segment {index} is not restored by the checkpoint runner"));
                            json!({"kind": "passive"})
                        }
                        ElementKind::Declared => {
                            reasons.insert(format!(
                                "declared element segment {index} requires review"
                            ));
                            json!({"kind": "declared"})
                        }
                    };
                    let items = match element.items {
                        ElementItems::Functions(reader) => {
                            json!({"kind": "functionIndices", "indices": reader.into_iter().collect::<wasmparser::Result<Vec<_>>>()?})
                        }
                        ElementItems::Expressions(ty, reader) => {
                            reasons.insert(format!("element segment {index} uses reference expressions requiring review"));
                            let expressions = reader
                                .into_iter()
                                .map(|expr| expression(expr?))
                                .collect::<Result<Vec<_>>>()?;
                            json!({"kind": "expressions", "referenceType": format!("{ty:?}"), "expressions": expressions})
                        }
                    };
                    elements.push(json!({"index": index, "mode": mode, "items": items}));
                }
            }
            Payload::DataSection(reader) => {
                for segment in reader {
                    let segment = segment?;
                    let index = data.len();
                    let mode = match segment.kind {
                        DataKind::Active {
                            memory_index,
                            offset_expr,
                        } => {
                            json!({"kind": "active", "memoryIndex": memory_index, "offsetOperators": expression(offset_expr)?})
                        }
                        DataKind::Passive => {
                            reasons.insert(format!("passive data segment {index} is not restored by the checkpoint runner"));
                            json!({"kind": "passive"})
                        }
                    };
                    data.push(json!({"index": index, "mode": mode, "bytes": segment.data.len()}));
                }
            }
            Payload::CodeSectionEntry(body) => {
                code_bodies += 1;
                for local in body.get_locals_reader()? {
                    if !scalar(local?.1) {
                        reasons.insert("non-scalar local storage requires review".into());
                    }
                }
                let mut reader = body.get_operators_reader()?;
                while !reader.eof() {
                    let op = reader.read()?;
                    instruction_count += 1;
                    let name = format!("{op:?}")
                        .split([' ', '{'])
                        .next()
                        .unwrap_or("unknown")
                        .to_owned();
                    *operator_counts.entry(name.clone()).or_default() += 1;
                    if let Operator::GlobalSet { global_index } = op {
                        *global_writes.entry(global_index).or_default() += 1;
                    }
                    let forbidden = match op {
                        Operator::TableSet { .. } => Some("table.set"),
                        Operator::TableGrow { .. } => Some("table.grow"),
                        Operator::TableFill { .. } => Some("table.fill"),
                        Operator::TableCopy { .. } => Some("table.copy"),
                        Operator::TableInit { .. } => Some("table.init"),
                        Operator::TableAtomicSet { .. } => Some("table.atomic.set"),
                        Operator::TableAtomicRmwXchg { .. } => Some("table.atomic.rmw.xchg"),
                        Operator::TableAtomicRmwCmpxchg { .. } => Some("table.atomic.rmw.cmpxchg"),
                        Operator::ElemDrop { .. } => Some("elem.drop"),
                        Operator::DataDrop { .. } => Some("data.drop"),
                        Operator::MemoryInit { .. } => Some("memory.init"),
                        _ => None,
                    };
                    if let Some(name) = forbidden {
                        *rejected_operator_counts.entry(name.to_owned()).or_default() += 1;
                        reasons.insert(format!(
                            "{name} mutates state outside the restored linear-memory image"
                        ));
                    }
                }
            }
            Payload::TagSection(_) => {
                reasons.insert("defined exception tags require review".into());
            }
            Payload::CustomSection(_)
            | Payload::CodeSectionStart { .. }
            | Payload::DataCountSection { .. }
            | Payload::End(_) => {}
            other => {
                reasons.insert(format!("unsupported module payload: {other:?}"));
            }
        }
    }

    let mutable_globals = globals
        .iter_mut()
        .filter(|global| global["mutable"] == true)
        .map(|global| {
            let index = global["index"].as_u64().expect("generated numeric index") as u32;
            let names = global_exports.get(&index).cloned().unwrap_or_default();
            if names.is_empty() {
                reasons.insert(format!(
                    "mutable global {index} is hidden from the checkpoint runner"
                ));
            }
            global["exportNames"] = json!(names);
            global["globalSetInstructions"] =
                json!(global_writes.get(&index).copied().unwrap_or(0));
            global.clone()
        })
        .collect::<Vec<_>>();
    if imports.len() != 1 || imported_functions != 1 {
        reasons.insert("probe requires exactly one approved entropy function import".into());
    }
    if tables.len() != 1 || imported_tables != 0 {
        reasons.insert("probe requires one defined table".into());
    }
    if memories.len() != 1 || imported_memories != 0 {
        reasons.insert("probe requires one defined memory".into());
    }
    for (name, kind) in [("memory", "Memory"), ("__indirect_function_table", "Table")] {
        if !exports
            .iter()
            .any(|export| export["name"] == name && export["kind"] == kind && export["index"] == 0)
        {
            reasons.insert(format!(
                "runner requires exported {name} at {kind} index zero"
            ));
        }
    }
    Ok(
        json!({"auditVersion": 1, "wasmparserVersion": "0.240.0", "binaryValidated": true,
        "checkpointStateGatePassed": reasons.is_empty(), "rejectionReasons": reasons,
        "scope": "Conservative state-layout gate for this exact probe image; not full conformance or production checkpoint authentication.",
        "wasmBytes": bytes.len(), "imports": imports, "exports": exports, "startFunction": start,
        "definedFunctionCount": defined_functions, "codeBodyCount": code_bodies, "instructionCount": instruction_count,
        "globalCount": imported_globals as usize + globals.len(), "globals": globals, "exportedMutableGlobals": mutable_globals,
        "tables": tables, "memories": memories, "elementSegments": elements, "dataSegments": data,
        "operatorCounts": operator_counts, "rejectedOperatorCounts": rejected_operator_counts,
        "globalSetCounts": global_writes}),
    )
}

fn main() -> ExitCode {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 2 {
        eprintln!("Usage: jovault-wasm-checkpoint-audit <input.wasm> <output.json>");
        return ExitCode::from(2);
    }
    let report = match fs::read(&args[0])
        .map_err(Into::into)
        .and_then(|bytes| audit(&bytes))
    {
        Ok(report) => report,
        Err(error) => json!({"auditVersion": 1, "wasmparserVersion": "0.240.0",
            "checkpointStateGatePassed": false, "fatalError": error.to_string()}),
    };
    let passed = report["checkpointStateGatePassed"] == true;
    let serialized =
        serde_json::to_string_pretty(&report).expect("JSON report is serializable") + "\n";
    if let Err(error) = fs::write(&args[1], &serialized) {
        eprintln!("Cannot write audit report: {error}");
        return ExitCode::from(2);
    }
    println!("{serialized}");
    if passed {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
