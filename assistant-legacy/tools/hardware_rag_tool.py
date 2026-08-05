import os
import glob
import json
from pathlib import Path
from typing import List, Dict, Any

from langchain_community.document_loaders import TextLoader, PyPDFLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import Chroma

class NeuroinjectorRAG:
    """
    Zero-token local RAG indexer and retriever for Neuroinjector docs, firmware, and manuals.
    """

    def __init__(self, repo_root: str = "../", db_dir: str = "../db/chroma_neuroinjector"):
        self.repo_root = Path(repo_root).resolve()
        self.db_dir = Path(db_dir).resolve()
        
        # Local, lightweight, fast embedding model (runs 100% on CPU, 0 API tokens)
        self.embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")
        self.vector_store = None

    def build_or_load_index(self, force_reindex: bool = False) -> Chroma:
        """Builds Chroma DB from local repo files or loads existing index."""
        if self.db_dir.exists() and not force_reindex:
            print("Loading existing local vector index...")
            self.vector_store = Chroma(
                persist_directory=str(self.db_dir),
                embedding_function=self.embeddings
            )
            return self.vector_store

        print("Indexing Neuroinjector repository files...")
        docs = []

        # 1. Load ReadMe.md
        readme_path = self.repo_root / "ReadMe.md"
        if readme_path.exists():
            docs.extend(TextLoader(str(readme_path), encoding="utf-8").load())

        # 2. Load Firmware (.ino)
        ino_files = glob.glob(str(self.repo_root / "**" / "*.ino"), recursive=True)
        for ino in ino_files:
            docs.extend(TextLoader(ino, encoding="utf-8").load())

        # 3. Load PDFs in documentation/
        pdf_files = glob.glob(str(self.repo_root / "documentation" / "*.pdf"))
        for pdf in pdf_files:
            docs.extend(PyPDFLoader(pdf).load())

        # 4. Load Syringe Data JSON
        json_path = self.repo_root / "webapp" / "data" / "hamilton_syringes.json"
        if json_path.exists():
            docs.extend(TextLoader(str(json_path), encoding="utf-8").load())

        # Split texts into chunks (350 tokens ~ 1400 chars, 150 char overlap)
        text_splitter = RecursiveCharacterTextSplitter(chunk_size=1400, chunk_overlap=150)
        chunks = text_splitter.split_documents(docs)

        # Create local Chroma DB
        self.vector_store = Chroma.from_documents(
            documents=chunks,
            embedding=self.embeddings,
            persist_directory=str(self.db_dir)
        )
        print(f"Indexed {len(chunks)} chunks successfully in {self.db_dir}.")
        return self.vector_store

    def query(self, user_query: str, top_k: int = 3) -> str:
        """Retrieves top-K relevant snippets to keep LLM context small."""
        if not self.vector_store:
            self.build_or_load_index()

        results = self.vector_store.similarity_search(user_query, k=top_k)
        
        context_snippets = []
        for i, doc in enumerate(results, 1):
            source = Path(doc.metadata.get("source", "unknown")).name
            context_snippets.append(f"[Snippet {i} | Source: {source}]\n{doc.page_content}")

        return "\n\n---\n\n".join(context_snippets)


if __name__ == "__main__":
    # Test Indexer
    rag = NeuroinjectorRAG()
    rag.build_or_load_index()
    
    # Example Hardware/Assembly Query
    test_query = "What stepper motor driver pins are used and how is the home limit switch configured?"
    retrieved_context = rag.query(test_query, top_k=2)
    print("\nSearch Test Results:\n", retrieved_context)