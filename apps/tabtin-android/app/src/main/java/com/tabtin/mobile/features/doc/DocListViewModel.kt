package com.tabtin.mobile.features.doc

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.annotation.StringRes
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.doc.Doc
import com.tabtin.mobile.data.repository.DocRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

public data class DocListUiState(
    val documents: List<Doc> = emptyList(),
    val isLoading: Boolean = false,
    val isCreating: Boolean = false,
    @StringRes val errorRes: Int? = null,
    val createdDocId: String? = null,
    @StringRes val snackbarRes: Int? = null,
    val createDocumentQuotaExceeded: AppError.DocumentQuotaExceeded? = null,
)

@HiltViewModel
public class DocListViewModel @Inject constructor(
    private val docRepository: DocRepository,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {

    public val spaceId: String = savedStateHandle["spaceId"] ?: ""

    private val _uiState = MutableStateFlow(DocListUiState())
    public val uiState: StateFlow<DocListUiState> = _uiState.asStateFlow()

    init {
        loadDocuments()
    }

    public fun refresh(): Unit = loadDocuments()

    private fun loadDocuments() {
        if (spaceId.isEmpty()) return
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, errorRes = null)
            try {
                val docs = docRepository.listDocuments()
                _uiState.value = _uiState.value.copy(documents = docs, isLoading = false)
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(
                    errorRes = R.string.doc_error_load_failed,
                    isLoading = false,
                )
            }
        }
    }

    public fun createDocument() {
        if (spaceId.isEmpty() || _uiState.value.isCreating) return
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(
                isCreating = true,
                createDocumentQuotaExceeded = null,
            )
            try {
                val detail = docRepository.createDocument(title = "")
                val newDoc = detail.document
                val updated = listOf(newDoc) + _uiState.value.documents
                _uiState.value = _uiState.value.copy(
                    documents = updated,
                    isCreating = false,
                    createdDocId = newDoc.id,
                )
            } catch (error: Exception) {
                val quotaExceeded = error as? AppError.DocumentQuotaExceeded
                _uiState.value = _uiState.value.copy(
                    isCreating = false,
                    snackbarRes = if (quotaExceeded == null) R.string.doc_error_create_failed else null,
                    createDocumentQuotaExceeded = quotaExceeded,
                )
            }
        }
    }

    public fun consumeCreatedDocId() {
        _uiState.value = _uiState.value.copy(createdDocId = null)
    }

    public fun deleteDocument(docId: String) {
        viewModelScope.launch {
            try {
                docRepository.archiveDocument(docId)
                val updated = _uiState.value.documents.filter { it.id != docId }
                _uiState.value = _uiState.value.copy(documents = updated)
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(
                    snackbarRes = R.string.doc_error_delete_failed,
                )
            }
        }
    }

    public fun consumeSnackbar() {
        _uiState.value = _uiState.value.copy(snackbarRes = null)
    }

    public fun dismissCreateDocumentQuotaExceeded() {
        _uiState.value = _uiState.value.copy(createDocumentQuotaExceeded = null)
    }
}
