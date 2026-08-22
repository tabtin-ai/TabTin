package com.tabtin.mobile.features.doc.model

import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeDocumentSafetyPolicyTest {

    private fun malformedTableDimensionDocument(
        attribute: String,
        value: JsonElement,
    ) = buildJsonObject {
        put("type", "doc")
        put("content", buildJsonArray {
            add(buildJsonObject {
                put("type", "table")
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "tableRow")
                        put("content", buildJsonArray {
                            add(buildJsonObject {
                                put("type", "tableCell")
                                put("attrs", buildJsonObject { put(attribute, value) })
                                put("content", buildJsonArray {})
                            })
                        })
                    })
                })
            })
        })
    }

    @Test
    fun `conflict rebase comparison ignores generated ids and schema defaults`() {
        fun document(attrs: kotlinx.serialization.json.JsonObject? = null) = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "paragraph")
                    if (attrs != null) put("attrs", attrs)
                    put("content", buildJsonArray {
                        add(buildJsonObject { put("type", "text"); put("text", "正文") })
                    })
                })
            })
        }
        val committed = document()
        val serverStamped = document(buildJsonObject {
            put("blockId", "server-generated")
            put("textAlign", JsonNull)
        })
        val unknownAttributeChanged = document(buildJsonObject {
            put("blockId", "server-generated")
            put("source", "collaborator")
        })

        assertTrue(NativeDocumentConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle = "标题",
            remoteDocument = serverStamped,
            committedTitle = "标题",
            committedDocument = committed,
        ))
        assertFalse(NativeDocumentConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle = "另一个标题",
            remoteDocument = serverStamped,
            committedTitle = "标题",
            committedDocument = committed,
        ))
        assertFalse(NativeDocumentConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle = "标题",
            remoteDocument = unknownAttributeChanged,
            committedTitle = "标题",
            committedDocument = committed,
        ))
    }

    @Test
    fun `conflict rebase ignores only known schema default values`() {
        fun document(canonicalized: Boolean, colspan: Int = 1) = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "codeBlock")
                    if (canonicalized) put("attrs", buildJsonObject {
                        put("blockId", "code-1")
                        put("language", JsonNull)
                    })
                    put("content", buildJsonArray {
                        add(buildJsonObject { put("type", "text"); put("text", "let value = 1") })
                    })
                })
                add(buildJsonObject {
                    put("type", "taskList")
                    if (canonicalized) put("attrs", buildJsonObject { put("blockId", "tasks-1") })
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "taskItem")
                            put("attrs", buildJsonObject {
                                if (canonicalized) put("blockId", "task-1")
                                put("checked", false)
                                if (canonicalized) put("todoId", JsonNull)
                            })
                            put("content", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "paragraph")
                                    if (canonicalized) put("attrs", buildJsonObject {
                                        put("blockId", "task-paragraph-1")
                                        put("textAlign", JsonNull)
                                    })
                                    put("content", buildJsonArray {
                                        add(buildJsonObject { put("type", "text"); put("text", "待办") })
                                    })
                                })
                            })
                        })
                    })
                })
                add(buildJsonObject {
                    put("type", "table")
                    if (canonicalized) put("attrs", buildJsonObject { put("blockId", "table-1") })
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "tableRow")
                            put("content", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "tableCell")
                                    if (canonicalized) put("attrs", buildJsonObject {
                                        put("colspan", colspan)
                                        put("rowspan", 1)
                                        put("colwidth", JsonNull)
                                    })
                                    put("content", buildJsonArray {
                                        add(buildJsonObject {
                                            put("type", "paragraph")
                                            if (canonicalized) put("attrs", buildJsonObject {
                                                put("blockId", "cell-paragraph-1")
                                                put("textAlign", JsonNull)
                                            })
                                            put("content", buildJsonArray {
                                                add(buildJsonObject { put("type", "text"); put("text", "单元格") })
                                            })
                                        })
                                    })
                                })
                            })
                        })
                    })
                })
            })
        }

        assertTrue(NativeDocumentConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle = "标题",
            remoteDocument = document(canonicalized = true),
            committedTitle = "标题",
            committedDocument = document(canonicalized = false),
        ))
        assertFalse(NativeDocumentConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle = "标题",
            remoteDocument = document(canonicalized = true, colspan = 2),
            committedTitle = "标题",
            committedDocument = document(canonicalized = false),
        ))
    }

    @Test
    fun `conflict rebase fails closed when node type is an object`() {
        val malformed = buildJsonObject {
            put("type", buildJsonObject {})
            put("content", buildJsonArray {})
        }

        assertFalse(NativeDocumentConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle = "标题",
            remoteDocument = malformed,
            committedTitle = "标题",
            committedDocument = malformed,
        ))
    }

    @Test
    fun `conflict rebase fails closed when colspan is an object`() {
        val malformed = malformedTableDimensionDocument("colspan", buildJsonObject {})

        assertFalse(NativeDocumentConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle = "标题",
            remoteDocument = malformed,
            committedTitle = "标题",
            committedDocument = malformed,
        ))
    }

    @Test
    fun `conflict rebase fails closed when rowspan is an array`() {
        val malformed = malformedTableDimensionDocument("rowspan", buildJsonArray {})

        assertFalse(NativeDocumentConflictRebasePolicy.remoteMatchesCommittedSnapshot(
            remoteTitle = "标题",
            remoteDocument = malformed,
            committedTitle = "标题",
            committedDocument = malformed,
        ))
    }

    @Test
    fun `missing root content is never treated as an editable empty document`() {
        val document = buildJsonObject { put("type", "doc") }

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `wrong root content type fails closed`() {
        val document = buildJsonObject {
            put("type", "doc")
            put("content", JsonPrimitive("not-an-array"))
        }

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `explicit empty root content remains editable`() {
        val document = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {})
        }

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `unknown inline makes document native read only`() {
        val document = documentWithInline(
            buildJsonObject {
                put("type", "mention")
                put("attrs", buildJsonObject { put("id", "user-1") })
            },
        )

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `reconstructible unknown mark keeps top level paragraph editable`() {
        val document = documentWithInline(
            buildJsonObject {
                put("type", "text")
                put("text", "hello")
                put("marks", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "commentAnchor")
                        put("attrs", buildJsonObject { put("threadId", "thread-1") })
                    })
                })
            },
        )

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `malformed unknown marks stay native read only`() {
        val emptyType = documentWithInline(
            buildJsonObject {
                put("type", "text")
                put("text", "hello")
                put("marks", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "")
                        put("attrs", buildJsonObject { put("threadId", "thread-1") })
                    })
                })
            },
        )
        val nonObjectAttrs = documentWithInline(
            buildJsonObject {
                put("type", "text")
                put("text", "hello")
                put("marks", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "futureMark")
                        put("attrs", JsonPrimitive("ai"))
                    })
                })
            },
        )
        val emptyAttrs = documentWithInline(
            buildJsonObject {
                put("type", "text")
                put("text", "hello")
                put("marks", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "futureMark")
                        put("attrs", buildJsonObject {})
                    })
                })
            },
        )
        val extraKey = documentWithInline(
            buildJsonObject {
                put("type", "text")
                put("text", "hello")
                put("marks", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "futureMark")
                        put("attrs", buildJsonObject { put("weight", 9) })
                        put("meta", JsonPrimitive(1))
                    })
                })
            },
        )

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(emptyType))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(nonObjectAttrs))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(emptyAttrs))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(extraKey))
    }

    @Test
    fun `marks must be an array of objects`() {
        val nonArray = documentWithInline(
            buildJsonObject {
                put("type", "text")
                put("text", "hello")
                put("marks", JsonPrimitive("bold"))
            },
        )
        val primitiveEntry = documentWithInline(
            buildJsonObject {
                put("type", "text")
                put("text", "hello")
                put("marks", buildJsonArray { add(JsonPrimitive("bold")) })
            },
        )

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(nonArray))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(primitiveEntry))
    }

    @Test
    fun `supported mark with an unpreserved attribute fails closed`() {
        val document = documentWithInline(
            buildJsonObject {
                put("type", "text")
                put("text", "hello")
                put("marks", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "bold")
                        put("attrs", buildJsonObject { put("source", "desktop") })
                    })
                })
            },
        )

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `canonical blank link target is editable when native model preserves it`() {
        val document = documentWithInline(
            buildJsonObject {
                put("type", "text")
                put("text", "hello")
                put("marks", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "link")
                        put("attrs", buildJsonObject {
                            put("href", "https://www.example.com")
                            put("target", "_blank")
                        })
                    })
                })
            },
        )

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `noncanonical link target shapes fail closed`() {
        fun documentWithLinkAttrs(attrs: kotlinx.serialization.json.JsonObject) =
            documentWithInline(
                buildJsonObject {
                    put("type", "text")
                    put("text", "hello")
                    put("marks", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "link")
                            put("attrs", attrs)
                        })
                    })
                },
            )

        val rejected = listOf(
            buildJsonObject {
                put("href", "")
                put("target", "_blank")
            },
            buildJsonObject {
                put("href", "https://www.example.com")
                put("target", "_self")
            },
            buildJsonObject {
                put("href", "https://www.example.com")
                put("target", 7)
            },
            buildJsonObject {
                put("href", "https://www.example.com")
                put("target", JsonNull)
            },
            buildJsonObject {
                put("href", "https://www.example.com")
                put("target", "_blank")
                put("rel", "noopener noreferrer")
            },
        )

        rejected.forEach { attrs ->
            assertFalse(
                "link attrs should fail closed: $attrs",
                NativeDocumentSafetyPolicy.canEditWithoutLoss(documentWithLinkAttrs(attrs)),
            )
        }
    }

    @Test
    fun `supported text marks and link are editable`() {
        val document = documentWithInline(
            buildJsonObject {
                put("type", "text")
                put("text", "hello")
                put("marks", buildJsonArray {
                    add(buildJsonObject { put("type", "bold") })
                    add(buildJsonObject {
                        put("type", "link")
                        put("attrs", buildJsonObject { put("href", "https://www.example.com") })
                    })
                })
            },
        )

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `text style attributes that Editable cannot round trip fail closed`() {
        fun documentWithMark(type: String, attrs: kotlinx.serialization.json.JsonObject) =
            documentWithInline(
                buildJsonObject {
                    put("type", "text")
                    put("text", "styled")
                    put("marks", buildJsonArray {
                        add(buildJsonObject {
                            put("type", type)
                            put("attrs", attrs)
                        })
                    })
                },
            )

        val unsafeMarks = listOf(
            documentWithMark("textStyle", buildJsonObject { put("backgroundColor", "#ffff00") }),
            documentWithMark("textStyle", buildJsonObject { put("fontSize", "18px") }),
            documentWithMark("textStyle", buildJsonObject { put("fontFamily", "Inter") }),
            documentWithMark("textStyle", buildJsonObject {
                put("color", "#112233")
                put("fontSize", "18px")
            }),
            documentWithMark("textStyle", buildJsonObject { put("color", "rgb(17, 34, 51)") }),
            documentWithMark("textStyle", buildJsonObject { put("color", "#80112233") }),
            documentWithMark("highlight", buildJsonObject { put("color", "var(--warning-bg)") }),
        )

        unsafeMarks.forEach { document ->
            assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
        }
    }

    @Test
    fun `six digit color only text style and highlight stay editable`() {
        fun documentWithMark(type: String, color: String) = documentWithInline(
            buildJsonObject {
                put("type", "text")
                put("text", "styled")
                put("marks", buildJsonArray {
                    add(buildJsonObject {
                        put("type", type)
                        put("attrs", buildJsonObject { put("color", color) })
                    })
                })
            },
        )

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            documentWithMark("textStyle", "#112233"),
        ))
        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            documentWithMark("highlight", "#FDE68A"),
        ))
    }

    @Test
    fun `only exact lowercase yellow extends the editable named color contract for highlight`() {
        fun documentWithMark(
            type: String,
            color: String,
            addFutureAttribute: Boolean = false,
        ) = documentWithInline(
            buildJsonObject {
                put("type", "text")
                put("text", "styled")
                put("marks", buildJsonArray {
                    add(buildJsonObject {
                        put("type", type)
                        put("attrs", buildJsonObject {
                            put("color", color)
                            if (addFutureAttribute) put("future", true)
                        })
                    })
                })
            },
        )

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            documentWithMark("highlight", "yellow"),
        ))

        val rejected = listOf(
            documentWithMark("textStyle", "yellow"),
            documentWithMark("highlight", "red"),
            documentWithMark("highlight", "YELLOW"),
            documentWithMark("highlight", "var(--warning-bg)"),
            documentWithMark("highlight", "rgb(255, 255, 0)"),
            documentWithMark("highlight", "#FF0"),
            documentWithMark("highlight", "#80FFFF00"),
            documentWithMark("highlight", "yellow", addFutureAttribute = true),
        )
        rejected.forEach { document ->
            assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
        }
    }

    @Test
    fun `canonical text alignment stays editable across native text containers`() {
        fun textBlock(
            type: String,
            alignment: JsonElement? = null,
            includeAlignment: Boolean = true,
        ) = buildJsonObject {
            put("type", type)
            put("attrs", buildJsonObject {
                if (type == "heading") put("level", 2)
                if (includeAlignment) put("textAlign", alignment ?: JsonNull)
            })
            put("content", buildJsonArray {
                add(buildJsonObject { put("type", "text"); put("text", "正文") })
            })
        }

        fun documentWith(content: JsonElement) = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(content)
            })
        }

        fun quoteWith(alignment: JsonElement) = buildJsonObject {
            put("type", "blockquote")
            put("content", buildJsonArray {
                add(textBlock("paragraph", alignment))
            })
        }

        fun listWith(
            listType: String,
            itemType: String,
            alignment: JsonElement,
        ) = buildJsonObject {
            put("type", listType)
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", itemType)
                    if (itemType == "taskItem") {
                        put("attrs", buildJsonObject { put("checked", false) })
                    }
                    put("content", buildJsonArray {
                        add(textBlock("paragraph", alignment))
                    })
                })
            })
        }

        listOf("left", "center", "right", "justify").forEach { alignment ->
            val value = JsonPrimitive(alignment)
            assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(
                documentWith(textBlock("paragraph", value)),
            ))
            assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(
                documentWith(textBlock("heading", value)),
            ))
            assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(documentWith(quoteWith(value))))
            assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(
                documentWith(listWith("bulletList", "listItem", value)),
            ))
            assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(
                documentWith(listWith("orderedList", "listItem", value)),
            ))
            assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(
                documentWith(listWith("taskList", "taskItem", value)),
            ))
        }

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            documentWith(textBlock("paragraph", includeAlignment = false)),
        ))
        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            documentWith(textBlock("heading", includeAlignment = false)),
        ))
        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            documentWith(textBlock("paragraph", JsonNull)),
        ))
        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            documentWith(textBlock("heading", JsonNull)),
        ))
    }

    @Test
    fun `noncanonical text alignment and extra attributes fail closed`() {
        fun paragraph(
            alignment: JsonElement,
            addFutureAttribute: Boolean = false,
        ) = buildJsonObject {
            put("type", "paragraph")
            put("attrs", buildJsonObject {
                put("textAlign", alignment)
                if (addFutureAttribute) put("future", "unsafe")
            })
            put("content", buildJsonArray {
                add(buildJsonObject { put("type", "text"); put("text", "正文") })
            })
        }

        fun heading(
            alignment: JsonElement,
            addFutureAttribute: Boolean = false,
        ) = buildJsonObject {
            put("type", "heading")
            put("attrs", buildJsonObject {
                put("level", 2)
                put("textAlign", alignment)
                if (addFutureAttribute) put("future", "unsafe")
            })
            put("content", buildJsonArray {
                add(buildJsonObject { put("type", "text"); put("text", "标题") })
            })
        }

        fun documentWith(content: JsonElement) = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray { add(content) })
        }

        listOf(
            JsonPrimitive("start"),
            JsonPrimitive("end"),
            JsonPrimitive("LEFT"),
            JsonPrimitive(""),
            JsonPrimitive(1),
            JsonPrimitive(true),
            buildJsonArray { add(JsonPrimitive("center")) },
            buildJsonObject { put("value", "center") },
        ).forEach { alignment ->
            assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(
                documentWith(paragraph(alignment)),
            ))
            assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(
                documentWith(heading(alignment)),
            ))
        }
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            documentWith(paragraph(JsonPrimitive("center"), addFutureAttribute = true)),
        ))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            documentWith(heading(JsonPrimitive("center"), addFutureAttribute = true)),
        ))

        val unsafeQuote = buildJsonObject {
            put("type", "blockquote")
            put("content", buildJsonArray { add(paragraph(JsonPrimitive("start"))) })
        }
        val unsafeList = buildJsonObject {
            put("type", "bulletList")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "listItem")
                    put("content", buildJsonArray { add(paragraph(JsonPrimitive("end"))) })
                })
            })
        }
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(documentWith(unsafeQuote)))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(documentWith(unsafeList)))
    }

    @Test
    fun `heading level must be a supported integer`() {
        fun heading(level: JsonPrimitive) = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "heading")
                    put("attrs", buildJsonObject { put("level", level) })
                    put("content", buildJsonArray {
                        add(buildJsonObject { put("type", "text"); put("text", "title") })
                    })
                })
            })
        }

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(heading(JsonPrimitive("2"))))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(heading(JsonPrimitive(7))))
    }

    @Test
    fun `code block marks fail closed because serializer emits plain code text`() {
        val document = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "codeBlock")
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "text")
                            put("text", "val x = 1")
                            put("marks", buildJsonArray { add(buildJsonObject { put("type", "bold") }) })
                        })
                    })
                })
            })
        }

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `blockquote container block id is editable because the container keeps its own identity`() {
        fun quoteWith(containerAttrs: JsonObject) = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "blockquote")
                    put("attrs", containerAttrs)
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "paragraph")
                            put("attrs", buildJsonObject { put("blockId", "quote-child") })
                            put("content", buildJsonArray {
                                add(buildJsonObject { put("type", "text"); put("text", "quote") })
                            })
                        })
                    })
                })
            })
        }

        // 协作编辑器给每个引用容器都写 blockId，这是真实文档的常态形态。
        assertTrue(
            NativeDocumentSafetyPolicy.canEditWithoutLoss(
                quoteWith(buildJsonObject { put("blockId", "quote-parent") }),
            ),
        )
        // 写回后会改变 JSON 形态或无法重建的身份继续 fail closed。
        assertFalse(
            NativeDocumentSafetyPolicy.canEditWithoutLoss(
                quoteWith(buildJsonObject { put("blockId", JsonNull) }),
            ),
        )
        assertFalse(
            NativeDocumentSafetyPolicy.canEditWithoutLoss(
                quoteWith(buildJsonObject { put("blockId", "quote-parent"); put("marker", "custom") }),
            ),
        )
    }

    @Test
    fun `unknown top level block makes whole document read only`() {
        val document = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "tabDataEmbed")
                    put("attrs", buildJsonObject { put("tableId", "table-1") })
                })
            })
        }

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `list content containing a non node fails closed`() {
        val document = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "bulletList")
                    put("content", buildJsonArray { add(JsonPrimitive("hidden item")) })
                })
            })
        }

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `list attrs that native serializer drops fail closed`() {
        fun taskWithTodoId() = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "taskList")
                    put("attrs", buildJsonObject { put("blockId", "list-parent") })
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "taskItem")
                            put("attrs", buildJsonObject {
                                put("checked", false)
                                put("todoId", "todo-1")
                            })
                            put("content", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "paragraph")
                                    put("content", buildJsonArray {
                                        add(buildJsonObject { put("type", "text"); put("text", "todo") })
                                    })
                                })
                            })
                        })
                    })
                })
            })
        }

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(taskWithTodoId()))
    }

    @Test
    fun `ordered list accepts only the canonical null type attrs it can preserve`() {
        fun document(attrs: kotlinx.serialization.json.JsonObject) = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "orderedList")
                    put("attrs", attrs)
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "listItem")
                            put("content", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "paragraph")
                                    put("content", buildJsonArray {
                                        add(buildJsonObject {
                                            put("type", "text")
                                            put("text", "第一项")
                                        })
                                    })
                                })
                            })
                        })
                    })
                })
            })
        }

        val canonical = document(buildJsonObject {
            put("start", 1)
            put("type", JsonNull)
        })
        val nonNullType = document(buildJsonObject {
            put("start", 1)
            put("type", "decimal")
        })
        val missingStart = document(buildJsonObject {
            put("type", JsonNull)
        })
        val nullStart = document(buildJsonObject {
            put("start", JsonNull)
            put("type", JsonNull)
        })
        val unknownAttribute = document(buildJsonObject {
            put("start", 1)
            put("type", JsonNull)
            put("marker", "custom")
        })
        val parentIdentity = document(buildJsonObject {
            put("start", 1)
            put("type", JsonNull)
            put("blockId", "ordered-list-parent")
        })

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(canonical))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(nonNullType))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(missingStart))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(nullStart))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(unknownAttribute))
        // 容器持久身份由 DocBlock.listBlockId 承载并原样写回，不再整块 fail-closed。
        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(parentIdentity))
    }

    @Test
    fun `inline mathematics must use canonical attrs`() {
        val legacyAlias = documentWithInline(
            buildJsonObject {
                put("type", "math_inline")
                put("attrs", buildJsonObject { put("text", "x+y") })
            },
        )
        val displayMath = documentWithInline(
            buildJsonObject {
                put("type", "mathematics")
                put("attrs", buildJsonObject {
                    put("latex", "x+y")
                    put("display", true)
                })
            },
        )

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(legacyAlias))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(displayMath))
    }

    @Test
    fun `empty table remains read only because rows cannot be mapped`() {
        val document = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject { put("type", "table") })
            })
        }

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `rectangular table with complex cells allows safe per cell editing`() {
        val document = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "table")
                    put("attrs", buildJsonObject { put("layout", "fixed") })
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "tableRow")
                            put("content", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "tableCell")
                                    put("content", buildJsonArray {
                                        add(buildJsonObject {
                                            put("type", "paragraph")
                                            put("content", buildJsonArray {
                                                add(buildJsonObject {
                                                    put("type", "text")
                                                    put("text", "复杂首段")
                                                })
                                            })
                                        })
                                        add(buildJsonObject {
                                            put("type", "bulletList")
                                            put("content", buildJsonArray { })
                                        })
                                    })
                                })
                                add(buildJsonObject {
                                    put("type", "tableCell")
                                    put("content", buildJsonArray {
                                        add(buildJsonObject {
                                            put("type", "paragraph")
                                            put("content", buildJsonArray {
                                                add(buildJsonObject {
                                                    put("type", "text")
                                                    put("text", "可编辑")
                                                })
                                            })
                                        })
                                    })
                                })
                            })
                        })
                    })
                })
            })
        }

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `simple table paragraph allows canonical bold marks`() {
        val paragraph = tableParagraph(
            buildJsonObject {
                put("type", "text")
                put("text", "加粗备注")
                put("marks", buildJsonArray {
                    add(buildJsonObject { put("type", "bold") })
                })
            },
        )

        assertTrue(NativeDocumentSafetyPolicy.isSimpleEditableTableParagraph(paragraph))
        assertTrue(NativeDocumentSafetyPolicy.isSimpleEditableTable(simpleTableWith(paragraph)))
    }

    @Test
    fun `simple table paragraph rejects empty marks array`() {
        val paragraph = tableParagraph(
            buildJsonObject {
                put("type", "text")
                put("text", "空 marks")
                put("marks", buildJsonArray {})
            },
        )

        assertFalse(NativeDocumentSafetyPolicy.isSimpleEditableTableParagraph(paragraph))
        assertFalse(NativeDocumentSafetyPolicy.isSimpleEditableTable(simpleTableWith(paragraph)))
    }

    @Test
    fun `simple table paragraph rejects unknown marks`() {
        val paragraph = tableParagraph(
            buildJsonObject {
                put("type", "text")
                put("text", "未知")
                put("marks", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "futureMark")
                        put("attrs", buildJsonObject { put("weight", 9) })
                    })
                })
            },
        )

        assertFalse(NativeDocumentSafetyPolicy.isSimpleEditableTableParagraph(paragraph))
        assertFalse(NativeDocumentSafetyPolicy.isSimpleEditableTable(simpleTableWith(paragraph)))
    }

    @Test
    fun `merged table remains whole document read only`() {
        val document = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "table")
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "tableRow")
                            put("content", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "tableCell")
                                    put("attrs", buildJsonObject { put("colspan", 2) })
                                    put("content", buildJsonArray {
                                        add(buildJsonObject { put("type", "paragraph") })
                                    })
                                })
                            })
                        })
                    })
                })
            })
        }

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `standalone inline image paragraph is editable`() {
        val document = documentWithInline(
            buildJsonObject {
                put("type", "image")
                put("attrs", buildJsonObject { put("fileId", "file-1") })
            },
        )

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `standalone image rejects explicit text alignment that its surface cannot render`() {
        fun imageParagraph(alignment: JsonElement? = null, includeAlignment: Boolean = true) =
            buildJsonObject {
                put("type", "doc")
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "paragraph")
                        if (includeAlignment) {
                            put("attrs", buildJsonObject {
                                put("textAlign", alignment ?: JsonNull)
                            })
                        }
                        put("content", buildJsonArray {
                            add(buildJsonObject {
                                put("type", "image")
                                put("attrs", buildJsonObject { put("fileId", "file-1") })
                            })
                        })
                    })
                })
            }

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            imageParagraph(includeAlignment = false),
        ))
        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(imageParagraph(JsonNull)))
        listOf("left", "center", "right", "justify").forEach { alignment ->
            assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(
                imageParagraph(JsonPrimitive(alignment)),
            ))
        }
    }

    @Test
    fun `blank camel file id falls back to snake file id`() {
        val document = documentWithInline(
            buildJsonObject {
                put("type", "image")
                put("attrs", buildJsonObject {
                    put("fileId", "")
                    put("file_id", "file-legacy")
                })
            },
        )

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `mixed text and image paragraph is editable`() {
        val document = mixedImageParagraphDocument(
            buildJsonObject {
                put("src", "https://example.com/a.png")
                put("fileId", "file-a")
                put("alt", "示例")
                put("title", "示例标题")
                put("width", 640)
                put("height", 360)
            },
        )

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `mixed paragraph with unmodelled image attrs stays read only`() {
        // 未知键与结构化值无法逐字段重建，必须继续走 rawNode 只读保留。
        val unknownKey = mixedImageParagraphDocument(
            buildJsonObject {
                put("src", "https://example.com/a.png")
                put("crop", "center")
            },
        )
        val structuredValue = mixedImageParagraphDocument(
            buildJsonObject {
                put("src", "https://example.com/a.png")
                put("width", buildJsonObject { put("value", 640) })
            },
        )
        val identityless = mixedImageParagraphDocument(buildJsonObject { put("alt", "只有描述") })

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(unknownKey))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(structuredValue))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(identityless))
    }

    private fun mixedImageParagraphDocument(imageAttrs: JsonObject): JsonObject = buildJsonObject {
        put("type", "doc")
        put("content", buildJsonArray {
            add(buildJsonObject {
                put("type", "paragraph")
                put("content", buildJsonArray {
                    add(buildJsonObject { put("type", "text"); put("text", "before") })
                    add(buildJsonObject {
                        put("type", "image")
                        put("attrs", imageAttrs)
                    })
                })
            })
        })
    }

    @Test
    fun `legacy top level image is read only`() {
        val document = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "image")
                    put("attrs", buildJsonObject { put("src", "https://example.com/legacy.png") })
                })
            })
        }

        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
    }

    @Test
    fun `canonical supported document survives parser serializer round trip`() {
        val document = buildJsonObject {
            put("type", "doc")
            put("content", buildJsonArray {
                add(buildJsonObject {
                    put("type", "paragraph")
                    put("attrs", buildJsonObject { put("blockId", "p1") })
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "text")
                            put("text", "hello")
                            put("marks", buildJsonArray {
                                add(buildJsonObject { put("type", "bold") })
                                add(buildJsonObject {
                                    put("type", "link")
                                    put("attrs", buildJsonObject { put("href", "https://www.example.com") })
                                })
                            })
                        })
                        add(buildJsonObject { put("type", "hardBreak") })
                        add(buildJsonObject {
                            put("type", "mathematics")
                            put("attrs", buildJsonObject { put("latex", "x+y") })
                        })
                    })
                })
                add(buildJsonObject {
                    put("type", "heading")
                    put("attrs", buildJsonObject { put("level", 2); put("blockId", "h1") })
                    put("content", buildJsonArray {
                        add(buildJsonObject { put("type", "text"); put("text", "Heading") })
                    })
                })
                add(buildJsonObject {
                    put("type", "codeBlock")
                    put("attrs", buildJsonObject { put("language", "kotlin"); put("blockId", "c1") })
                    put("content", buildJsonArray {
                        add(buildJsonObject { put("type", "text"); put("text", "val x = 1") })
                    })
                })
                add(buildJsonObject {
                    put("type", "blockquote")
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "paragraph")
                            put("attrs", buildJsonObject { put("blockId", "q1") })
                            put("content", buildJsonArray {
                                add(buildJsonObject { put("type", "text"); put("text", "quote") })
                            })
                        })
                    })
                })
                add(buildJsonObject {
                    put("type", "orderedList")
                    put("attrs", buildJsonObject { put("start", 3) })
                    put("content", buildJsonArray {
                        add(buildJsonObject {
                            put("type", "listItem")
                            put("attrs", buildJsonObject { put("blockId", "li1") })
                            put("content", buildJsonArray {
                                add(buildJsonObject {
                                    put("type", "paragraph")
                                    put("content", buildJsonArray {
                                        add(buildJsonObject { put("type", "text"); put("text", "third") })
                                    })
                                })
                            })
                        })
                    })
                })
                add(buildJsonObject {
                    put("type", "horizontalRule")
                    put("attrs", buildJsonObject { put("blockId", "hr1") })
                })
            })
        }

        assertTrue(NativeDocumentSafetyPolicy.canEditWithoutLoss(document))
        assertEquals(document, ProseMirrorParser.serializeBlocks(ProseMirrorParser.parseBlocks(document)))
    }

    private fun tableParagraph(inline: JsonObject) = buildJsonObject {
        put("type", "paragraph")
        put("content", buildJsonArray { add(inline) })
    }

    private fun simpleTableWith(paragraph: JsonObject) = buildJsonObject {
        put("type", "table")
        put("content", buildJsonArray {
            add(buildJsonObject {
                put("type", "tableRow")
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", "tableCell")
                        put("content", buildJsonArray { add(paragraph) })
                    })
                })
            })
        })
    }

    private fun documentWithInline(inline: kotlinx.serialization.json.JsonObject) = buildJsonObject {
        put("type", "doc")
        put("content", buildJsonArray {
            add(buildJsonObject {
                put("type", "paragraph")
                put("content", buildJsonArray { add(inline) })
            })
        })
    }

    private fun identifiedList(
        listType: String,
        containerAttrs: kotlinx.serialization.json.JsonObject,
        paragraphBlockId: JsonElement? = JsonPrimitive("blk-para"),
    ) = buildJsonObject {
        put("type", "doc")
        put("content", buildJsonArray {
            add(buildJsonObject {
                put("type", listType)
                put("attrs", containerAttrs)
                put("content", buildJsonArray {
                    add(buildJsonObject {
                        put("type", if (listType == "taskList") "taskItem" else "listItem")
                        put("attrs", buildJsonObject {
                            put("blockId", "blk-item")
                            if (listType == "taskList") put("checked", false)
                        })
                        put("content", buildJsonArray {
                            add(buildJsonObject {
                                put("type", "paragraph")
                                paragraphBlockId?.let {
                                    put("attrs", buildJsonObject { put("blockId", it) })
                                }
                                put("content", buildJsonArray {
                                    add(buildJsonObject { put("type", "text"); put("text", "项目") })
                                })
                            })
                        })
                    })
                })
            })
        })
    }

    @Test
    fun `collaborative list keeps all three identity levels editable`() {
        listOf(
            "bulletList" to buildJsonObject { put("blockId", "blk-list") },
            "taskList" to buildJsonObject { put("blockId", "blk-list") },
            "orderedList" to buildJsonObject { put("blockId", "blk-list"); put("start", 1) },
            "orderedList" to buildJsonObject {
                put("blockId", "blk-list")
                put("start", 1)
                put("type", JsonNull)
            },
        ).forEach { (listType, attrs) ->
            assertTrue(
                "$listType with container identity must stay editable",
                NativeDocumentSafetyPolicy.canEditWithoutLoss(identifiedList(listType, attrs)),
            )
        }
    }

    @Test
    fun `list identity shapes the serializer cannot reproduce still fail closed`() {
        // 容器身份只放行非空字符串；null 与非字符串写回后会改变 JSON 形态。
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            identifiedList("bulletList", buildJsonObject { put("blockId", JsonNull) }),
        ))
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            identifiedList("bulletList", buildJsonObject { put("blockId", 7) }),
        ))
        // 身份之外的未知容器属性仍不可编辑。
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            identifiedList("bulletList", buildJsonObject {
                put("blockId", "blk-list")
                put("collapsed", true)
            }),
        ))
        // 项内段落身份同样只放行非空字符串。
        assertFalse(NativeDocumentSafetyPolicy.canEditWithoutLoss(
            identifiedList(
                "bulletList",
                buildJsonObject { put("blockId", "blk-list") },
                paragraphBlockId = JsonNull,
            ),
        ))
    }
}
