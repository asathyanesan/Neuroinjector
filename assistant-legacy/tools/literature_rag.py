import os
import glob
import json
from pathlib import Path
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field

from langchain_community.document_loaders import PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import Chroma

# --- 1. Pydantic Schema for Strict, Minimal Token JSON Extraction ---
class InjectionProtocolJSON(BaseModel):
    target_region: str = Field(description="Target brain region (e.g., VTA, BLA, CA1)")
    animal_model: Dict[str, Any] = Field(description="Species, strain, weight (g), and age (weeks/p-day)")
    coordinates_bregma_mm: Dict[str, float] = Field(description="AP, ML, DV coordinates in mm relative to Bregma")
    injection_protocol: Dict[str, Any] = Field(description="Volume (nL), flow rate (nL/min), needle gauge, wait time (min)")
    source_paper: str = Field(description="Filename or title of the source paper")


# --- 2. Zero-Token Literature Vector Search & Extraction Engine ---
class LiteratureRAG:
    """
    Local-embedding RAG engine for parsing neurosurgery literature into structured JSON.
    """

    def __init__(self, literature_dir: str = "../literature", db_dir: str = "../db/chroma_literature"):
        self.literature_dir = Path(literature_dir).resolve()
        self.db_dir = Path(db_dir).resolve()
        
        # CPU-based local embeddings (0 API tokens consumed during indexing/search)
        self.embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")
        self.vector_store = None

    def build_or_load_index(self, force_reindex: bool = False) -> Chroma:
        """Indexes PDFs in assistant/literature/ or loads existing Chroma database."""
        if self.db_dir.exists() and not force_reindex:
            self.vector_store = Chroma(
                persist_directory=str(self.db_dir),
                embedding_function=self.embeddings
            )
            return self.vector_store

        print(f"Indexing literature PDFs from {self.literature_dir}...")
        docs = []
        pdf_files = glob.glob(str(self.literature_dir / "*.pdf"))

        if not pdf_files:
            print(f"Warning: No PDF files found in {self.literature_dir}. Add PDFs to index.")
            # Initialize empty store
            self.vector_store = Chroma(
                persist_directory=str(self.db_dir),
                embedding_function=self.embeddings
            )
            return self.vector_store

        for pdf_path in pdf_files:
            try:
                loader = PyPDFLoader(pdf_path)
                docs.extend(loader.load())
            except Exception as e:
                print(f"Error loading {pdf_path}: {e}")

        # Split text into chunks optimized for Methods sections
        text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000, 
            chunk_overlap=150,
            separators=["\n\n", "\n", "Stereotaxic", "Injection", "Methods", " "]
        )
        chunks = text_splitter.split_documents(docs)

        self.vector_store = Chroma.from_documents(
            documents=chunks,
            embedding=self.embeddings,
            persist_directory=str(self.db_dir)
        )
        print(f"Successfully indexed {len(chunks)} text chunks from {len(pdf_files)} papers.")
        return self.vector_store

    def search_protocol_chunks(self, target_region: str, top_k: int = 2) -> str:
        """
        Retrieves only top K relevant chunks (Methods/Stereotaxic sections).
        Returns a concise context string (~500-800 tokens max).
        """
        if not self.vector_store:
            self.build_or_load_index()

        query = f"stereotaxic surgery coordinates injection flow rate {target_region} Bregma AP ML DV"
        results = self.vector_store.similarity_search(query, k=top_k)

        if not results:
            return "No matching literature found."

        snippets = []
        for i, doc in enumerate(results, 1):
            source_file = Path(doc.metadata.get("source", "unknown")).name
            snippets.append(f"--- Paper Snippet {i} [{source_file}] ---\n{doc.page_content}")

        return "\n\n".join(snippets)


# Tool Function for LangChain / OpenAI Agent Call
def get_literature_protocol_context(target_region: str) -> str:
    """
    Called by Agent to retrieve surgical literature methods text for a target brain region.
    """
    rag = LiteratureRAG()
    return rag.search_protocol_chunks(target_region=target_region, top_k=2)


if __name__ == "__main__":
    # Test Run
    lit_rag = LiteratureRAG()
    lit_rag.build_or_load_index()
    
    test_target = "VTA"
    context = lit_rag.search_protocol_chunks(test_target)
    print(f"\nRetrieved Context for {test_target}:\n")
    print(context)