"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { X, Send, MoreVertical, Edit, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabaseClient";
import { DEFAULT_AVATAR_URL } from "@/lib/utils";

type Comment = {
  id: string;
  user_id: string;
  content: string;
  created_at: string;
  user: {
    id: string;
    username: string;
    full_name: string | null;
    avatar_url: string | null;
  };
};

type CommentPanelProps = {
  postId: string;
  isOpen: boolean;
  onClose: () => void;
  onCommentAdded?: (newCount?: number) => void;
};

export default function CommentPanel({ postId, isOpen, onClose, onCommentAdded }: CommentPanelProps) {
  const supabase = createClient();
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [commentText, setCommentText] = useState("");
  const [currentUser, setCurrentUser] = useState<{ id: string; username: string; avatar_url: string | null } | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const commentsEndRef = useRef<HTMLDivElement>(null);

  // Fetch current user
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from("profiles")
          .select("username, avatar_url")
          .eq("id", user.id)
          .single();
        
        setCurrentUser({
          id: user.id,
          username: profile?.username || user.email?.split("@")[0] || "user",
          avatar_url: profile?.avatar_url || null,
        });
      }
    })();
  }, [supabase]);

  // Fetch comments
  const fetchComments = useCallback(async () => {
    if (!postId || !isOpen) return;
    
    setLoading(true);
    try {
      const apiUrl = typeof window !== "undefined" 
        ? `${window.location.origin}/api/posts/${postId}/comments`
        : `/api/posts/${postId}/comments`;
      
      const res = await fetch(apiUrl, {
        method: "GET",
        credentials: "include",
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setComments(data.comments || []);
      } else {
        console.error("Failed to fetch comments:", data.error);
      }
    } catch (err) {
      console.error("Error fetching comments:", err);
    } finally {
      setLoading(false);
    }
  }, [postId, isOpen]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  // Scroll to bottom when comments update
  useEffect(() => {
    if (commentsEndRef.current) {
      commentsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [comments]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      // Check if click is outside any menu button or dropdown
      if (!target.closest('[aria-label="Comment options"]') && !target.closest('.absolute.right-0.top-8')) {
        setMenuOpenId(null);
      }
    };

    if (menuOpenId) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [menuOpenId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commentText.trim() || submitting || !currentUser) return;

    setSubmitting(true);
    const textToSubmit = commentText.trim();
    setCommentText("");

    try {
      const apiUrl = typeof window !== "undefined" 
        ? `${window.location.origin}/api/posts/${postId}/comments`
        : `/api/posts/${postId}/comments`;
      
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content: textToSubmit }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        // Add new comment to the list
        setComments((prev) => [data.comment, ...prev]);
        onCommentAdded?.(data.comments_count);
      } else {
        console.error("Failed to post comment:", data.error);
        alert(data.error || "Failed to post comment");
        setCommentText(textToSubmit); // Restore text on error
      }
    } catch (err) {
      console.error("Error posting comment:", err);
      alert("Failed to post comment. Please try again.");
      setCommentText(textToSubmit); // Restore text on error
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = (comment: Comment) => {
    setEditingCommentId(comment.id);
    setEditText(comment.content);
    setMenuOpenId(null);
  };

  const handleSaveEdit = async (commentId: string) => {
    if (!editText.trim() || submitting) return;

    setSubmitting(true);
    try {
      const apiUrl = typeof window !== "undefined" 
        ? `${window.location.origin}/api/posts/${postId}/comments/${commentId}`
        : `/api/posts/${postId}/comments/${commentId}`;
      
      const res = await fetch(apiUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ content: editText.trim() }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setComments((prev) =>
          prev.map((c) =>
            c.id === commentId ? { ...c, content: editText.trim() } : c
          )
        );
        setEditingCommentId(null);
        setEditText("");
      } else {
        console.error("Failed to update comment:", data.error);
        alert(data.error || "Failed to update comment");
      }
    } catch (err) {
      console.error("Error updating comment:", err);
      alert("Failed to update comment. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingCommentId(null);
    setEditText("");
  };

  const handleDelete = async (commentId: string) => {
    if (!confirm("Are you sure you want to delete this comment?")) {
      setMenuOpenId(null);
      return;
    }

    setDeletingCommentId(commentId);
    setMenuOpenId(null);
    
    try {
      const apiUrl = typeof window !== "undefined" 
        ? `${window.location.origin}/api/posts/${postId}/comments/${commentId}`
        : `/api/posts/${postId}/comments/${commentId}`;
      
      const res = await fetch(apiUrl, {
        method: "DELETE",
        credentials: "include",
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setComments((prev) => prev.filter((c) => c.id !== commentId));
        onCommentAdded?.(data.comments_count); // Update count with server value
      } else {
        console.error("Failed to delete comment:", data.error);
        alert(data.error || "Failed to delete comment");
      }
    } catch (err) {
      console.error("Error deleting comment:", err);
      alert("Failed to delete comment. Please try again.");
    } finally {
      setDeletingCommentId(null);
    }
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return "now";
    if (diffMins < 60) return `${diffMins}m`;
    if (diffHours < 24) return `${diffHours}h`;
    if (diffDays < 7) return `${diffDays}d`;
    return date.toLocaleDateString();
  };

  const displayName = (comment: Comment) => {
    return comment.user.full_name || comment.user.username || "user";
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      
      {/* Panel */}
      <div 
        className="relative w-[400px] max-w-[90vw] h-full bg-black border-l border-white/10 flex flex-col"
        style={{
          animation: "slideInRight 0.3s ease-out",
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <h2 className="text-lg font-semibold text-white">Comments</h2>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-white/10 transition"
            aria-label="Close comments"
          >
            <X className="h-5 w-5 text-white" />
          </button>
        </div>

        {/* Comments List */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-white/60">Loading comments...</p>
            </div>
          ) : comments.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-white/60">No comments yet. Be the first to comment!</p>
            </div>
          ) : (
            <>
              {comments.map((comment) => (
                <div key={comment.id} className="flex gap-3">
                  {/* Avatar */}
                  <div className="flex-shrink-0">
                    <img
                      src={comment.user.avatar_url || DEFAULT_AVATAR_URL}
                      alt={displayName(comment)}
                      className="h-10 w-10 rounded-full object-cover"
                    />
                  </div>

                  {/* Comment Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="text-white font-semibold text-sm">
                        {displayName(comment)}
                      </span>
                      <span className="text-white/50 text-xs">
                        {formatTime(comment.created_at)}
                      </span>
                      {/* Three-dot menu - only show for current user's comments */}
                      {currentUser && comment.user_id === currentUser.id && (
                        <div className="relative ml-auto">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuOpenId(menuOpenId === comment.id ? null : comment.id);
                            }}
                            className="p-1 rounded-full hover:bg-white/10 transition"
                            aria-label="Comment options"
                          >
                            <MoreVertical className="h-4 w-4 text-white/60" />
                          </button>
                          {menuOpenId === comment.id && (
                            <div className="absolute right-0 top-8 bg-[#1A1F22] border border-white/10 rounded-lg shadow-lg z-10 min-w-[120px]">
                              <button
                                onClick={() => handleEdit(comment)}
                                className="w-full px-4 py-2 text-left text-sm text-white hover:bg-white/10 flex items-center gap-2 rounded-t-lg"
                              >
                                <Edit className="h-4 w-4" />
                                Edit
                              </button>
                              <button
                                onClick={() => handleDelete(comment.id)}
                                disabled={deletingCommentId === comment.id}
                                className="w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-white/10 flex items-center gap-2 rounded-b-lg disabled:opacity-50"
                              >
                                <Trash2 className="h-4 w-4" />
                                {deletingCommentId === comment.id ? "Deleting..." : "Delete"}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {editingCommentId === comment.id ? (
                      <div className="space-y-2">
                        <input
                          type="text"
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          maxLength={500}
                          className="w-full bg-white/10 border border-white/20 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:ring-2 focus:ring-[#4A35C7]/60"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              handleSaveEdit(comment.id);
                            } else if (e.key === "Escape") {
                              handleCancelEdit();
                            }
                          }}
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleSaveEdit(comment.id)}
                            disabled={submitting || !editText.trim()}
                            className="px-3 py-1 bg-[#4A35C7] text-white text-xs rounded hover:bg-[#3D2BA3] disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button
                            onClick={handleCancelEdit}
                            disabled={submitting}
                            className="px-3 py-1 bg-white/10 text-white text-xs rounded hover:bg-white/20 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="text-white/90 text-sm break-words">
                        {comment.content}
                      </p>
                    )}
                  </div>
                </div>
              ))}
              <div ref={commentsEndRef} />
            </>
          )}
        </div>

        {/* Input Form */}
        {currentUser && (
          <form onSubmit={handleSubmit} className="px-4 py-3 border-t border-white/10">
            <div className="flex items-center gap-3">
              <img
                src={currentUser.avatar_url || DEFAULT_AVATAR_URL}
                alt={currentUser.username}
                className="h-8 w-8 rounded-full object-cover flex-shrink-0"
              />
              <input
                ref={inputRef}
                type="text"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Add a comment..."
                maxLength={500}
                className="flex-1 bg-white/10 border border-white/20 rounded-full px-4 py-2 text-white placeholder-white/50 text-sm focus:outline-none focus:ring-2 focus:ring-[#4A35C7]/60 focus:border-transparent"
                disabled={submitting}
              />
              <button
                type="submit"
                disabled={!commentText.trim() || submitting}
                className="p-2 rounded-full bg-[#4A35C7] text-white hover:bg-[#3D2BA3] disabled:opacity-50 disabled:cursor-not-allowed transition"
                aria-label="Post comment"
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

