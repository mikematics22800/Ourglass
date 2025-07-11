import { View, StyleSheet, Alert } from 'react-native';
import { useState, useEffect, useRef } from 'react';
import { 
  getMatchesForUser, 
  unmatchUsers, 
  supabase, 
  getChatRooms, 
  subscribeToChatRooms, 
  unsubscribeFromChannel,
  getOrCreateChatRoom,
  sendMessage,
  getMessages,
  markMessagesAsRead,
  subscribeToMessages,
  deleteMessage,
  markMatchesAsViewed
} from '../../lib/supabase';
import { generateChatSuggestions, getSuggestionCategories } from '../components/matches/chatSuggestions.js';
import { detectViolentThreats, isUserBanned, getUserStrikes } from '../components/matches/contentModeration';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import React from 'react';
import { 
  MatchesList, 
  ChatInterface, 
  LoadingScreen 
} from '../components/matches';

export default function MatchesScreen() {
  const router = useRouter();
  const [matches, setMatches] = useState([]);
  const [chatRooms, setChatRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processingUnmatch, setProcessingUnmatch] = useState(null);
  const [chatSubscription, setChatSubscription] = useState(null);
  
  // Chat state
  const [selectedMatch, setSelectedMatch] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [roomId, setRoomId] = useState(null);
  const [messageSubscription, setMessageSubscription] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [chatLoading, setChatLoading] = useState(false);

  // Chat suggestions state
  const [suggestions, setSuggestions] = useState([]);
  const [suggestionCategories, setSuggestionCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('icebreaker');
  const [generatingSuggestions, setGeneratingSuggestions] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Content moderation state
  const [moderatingMessage, setModeratingMessage] = useState(false);
  const [userStrikes, setUserStrikes] = useState(0);
  const [userBanned, setUserBanned] = useState(false);

  const flatListRef = useRef(null);

  // Get current user on component mount
  useEffect(() => {
    getCurrentUser();
  }, []);

  useEffect(() => {
    if (currentUserId) {
      loadMatches();
      loadChatRooms();
      setupChatSubscription();
    }

    return () => {
      if (chatSubscription) {
        unsubscribeFromChannel(chatSubscription);
      }
      if (messageSubscription) {
        unsubscribeFromChannel(messageSubscription);
      }
    };
  }, [currentUserId]);

  useFocusEffect(
    React.useCallback(() => {
      const markAsViewed = async () => {
        try {
          await markMatchesAsViewed();
        } catch (error) {
          console.error('❌ Error marking matches as viewed:', error);
        }
      };
      
      markAsViewed();
    }, [])
  );

  const getCurrentUser = async () => {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setCurrentUserId(user.id);
    }
  };

  const loadMatches = async () => {
    try {
      setLoading(true);
      const matchesData = await getMatchesForUser();
      setMatches(matchesData);
    } catch (error) {
      console.error('❌ Error loading matches:', error);
      Alert.alert('Error', 'Failed to load matches. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const loadChatRooms = async () => {
    try {
      const roomsData = await getChatRooms();
      setChatRooms(roomsData);
    } catch (error) {
      console.error('❌ Error loading chat rooms:', error);
    }
  };

  const setupChatSubscription = () => {
    if (chatSubscription) {
      unsubscribeFromChannel(chatSubscription);
    }
    
    const subscription = subscribeToChatRooms((newRoom, event) => {
      loadChatRooms();
    });
    setChatSubscription(subscription);
  };

  const handleUnmatch = async (userId, userName) => {
    try {
      setProcessingUnmatch(userId);
      
      const { data: { user: currentUser }, error: authError } = await supabase.auth.getUser();
      
      if (authError || !currentUser) {
        throw new Error('User not authenticated');
      }
      
      await unmatchUsers(currentUser.id, userId);
      
      setMatches(prevMatches => prevMatches.filter(match => match.id !== userId));
      
      Alert.alert('Unmatched', `You have unmatched with ${userName}`);
      
    } catch (error) {
      console.error('❌ Error unmatching:', error);
      Alert.alert('Error', 'Failed to unmatch. Please try again.');
    } finally {
      setProcessingUnmatch(null);
    }
  };

  const confirmUnmatch = (userId, userName) => {
    Alert.alert(
      'Unmatch',
      `Are you sure you want to unmatch with ${userName}? This action cannot be undone.`,
      [
        {
          text: 'Cancel',
          style: 'cancel'
        },
        {
          text: 'Unmatch',
          style: 'destructive',
          onPress: () => handleUnmatch(userId, userName)
        }
      ]
    );
  };

  const openChat = async (match) => {
    try {
      setChatLoading(true);
      setSelectedMatch(match);
      
      const chatRoomId = await getOrCreateChatRoom(currentUserId, match.id);
      setRoomId(chatRoomId);

      const messagesData = await getMessages(chatRoomId);
      setMessages(messagesData);

      await markMessagesAsRead(chatRoomId);

      if (messageSubscription) {
        unsubscribeFromChannel(messageSubscription);
      }

      const subscription = subscribeToMessages(chatRoomId, (newMessage, event) => {
        if (event === 'update') {
          setMessages(prev => 
            prev.map(msg => 
              msg.id === newMessage.id ? { ...msg, ...newMessage } : msg
            )
          );
        } else {
          if (newMessage.sender_id !== currentUserId) {
            setMessages(prev => [...prev, {
              ...newMessage,
              sender_name: 'Unknown User',
            }]);
            markMessagesAsRead(chatRoomId);
          } else {
            setMessages(prev => 
              prev.map(msg => 
                msg.isTemp && msg.sender_id === currentUserId
                  ? {
                      ...newMessage,
                      sender_name: 'You',
                      isTemp: false,
                    }
                  : msg
              )
            );
          }
        }
      });

      setMessageSubscription(subscription);

    } catch (error) {
      console.error('❌ Error opening chat:', error);
      Alert.alert('Error', 'Failed to open chat. Please try again.');
    } finally {
      setChatLoading(false);
    }
  };

  const closeChat = () => {
    setSelectedMatch(null);
    setMessages([]);
    setNewMessage('');
    setRoomId(null);
    setSuggestions([]);
    setSuggestionCategories([]);
    setShowSuggestions(false);
    if (messageSubscription) {
      unsubscribeFromChannel(messageSubscription);
      setMessageSubscription(null);
    }
  };

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !roomId || sending || moderatingMessage) return;

    try {
      setModeratingMessage(true);
      const messageContent = newMessage.trim();
      
      // Check for violent threats BEFORE sending
      const threatCheck = await detectViolentThreats(messageContent, currentUserId, selectedMatch.id);
      
      if (threatCheck.isThreat) {
        // Message blocked due to explicit violent content
        const userStrikeInfo = await getUserStrikes(currentUserId);
        setUserStrikes(userStrikeInfo.strikes);
        
        if (threatCheck.isBanned) {
          setUserBanned(true);
          Alert.alert(
            'Account Banned',
            'Your account has been banned for using explicit violent language. You have reached 3 strikes.',
            [{ text: 'OK', onPress: () => router.replace('/auth') }]
          );
          return;
        } else {
          const keywordList = threatCheck.detectedKeywords?.join(', ') || 'explicit violent language';
          Alert.alert(
            'Explicit Violent Language Detected',
            `Your message was blocked for containing: "${keywordList}". You now have ${userStrikeInfo.strikes}/3 strikes. ${threatCheck.strikesRemaining} strikes remaining before ban.`,
            [{ text: 'OK' }]
          );
          setNewMessage('');
          setModeratingMessage(false);
          return;
        }
      }
      
      // If no threats detected, proceed with sending
      setSending(true);
      setNewMessage('');

      // Create a temporary message ID that we can track
      const tempMessageId = `temp-${Date.now()}`;
      
      // Optimistically add message to UI
      const tempMessage = {
        id: tempMessageId,
        content: messageContent,
        message_type: 'text',
        sender_id: currentUserId,
        created_at: new Date().toISOString(),
        is_read: false,
        sender_name: 'You',
        isTemp: true,
      };
      
      setMessages(prev => [...prev, tempMessage]);

      // Send message to server
      const sentMessage = await sendMessage(roomId, messageContent, 'text');
      
      // Update the temporary message with the real message data
      setMessages(prev => 
        prev.map(msg => 
          msg.id === tempMessageId 
            ? {
                ...sentMessage,
                sender_name: 'You',
                isTemp: false,
              }
            : msg
        )
      );

    } catch (error) {
      console.error('❌ Error sending message:', error);
      
      // Check if the error is due to user being banned
      if (error.message?.includes('banned') || error.message?.includes('strikes')) {
        const isBanned = await isUserBanned(currentUserId);
        if (isBanned) {
          setUserBanned(true);
          Alert.alert(
            'Account Banned',
            'Your account has been banned for using explicit violent language.',
            [{ text: 'OK', onPress: () => router.replace('/auth') }]
          );
          return;
        }
      }
      
      Alert.alert('Error', 'Failed to send message. Please try again.');
      // Remove the temporary message on error
      setMessages(prev => prev.filter(msg => msg.id !== tempMessageId));
      // Restore the message input
      setNewMessage(messageContent);
    } finally {
      setSending(false);
      setModeratingMessage(false);
    }
  };

  const handleDeleteMessage = async (messageId) => {
    Alert.alert(
      'Delete Message',
      'Are you sure you want to delete this message?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMessage(messageId);
              setMessages(prev => prev.filter(msg => msg.id !== messageId));
            } catch (error) {
              console.error('❌ Error deleting message:', error);
              Alert.alert('Error', 'Failed to delete message.');
            }
          },
        },
      ]
    );
  };

  const scrollToBottom = () => {
    if (flatListRef.current && messages.length > 0) {
      flatListRef.current.scrollToEnd({ animated: true });
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (selectedMatch && currentUserId) {
      updateSuggestionCategories();
    }
  }, [messages, selectedMatch, currentUserId]);

  // Removed automatic suggestion generation - now only generates when user selects a category

  // Check user ban status and load strikes
  useEffect(() => {
    const checkUserBanStatus = async () => {
      if (currentUserId) {
        try {
          const isBanned = await isUserBanned(currentUserId);
          
          if (isBanned) {
            setUserBanned(true);
            Alert.alert(
              'Account Banned',
              'Your account has been banned for using explicit violent language.',
              [{ text: 'OK', onPress: () => router.replace('/auth') }]
            );
            return;
          }
          
          const strikeInfo = await getUserStrikes(currentUserId);
          setUserStrikes(strikeInfo.strikes);
          
        } catch (error) {
          console.error('❌ Error checking user ban status:', error);
        }
      }
    };
    
    checkUserBanStatus();
  }, [currentUserId]);



  const generateSuggestions = async (category = 'general') => {
    if (!selectedMatch || !currentUserId || generatingSuggestions) return;

    try {
      setGeneratingSuggestions(true);
      setSelectedCategory(category);
      
      const recentMessages = messages.slice(-10);
      const newSuggestions = await generateChatSuggestions(
        currentUserId,
        selectedMatch.id,
        recentMessages,
        category
      );
      
      setSuggestions(newSuggestions);
      
    } catch (error) {
      console.error('❌ Error generating suggestions:', error);
      Alert.alert('Error', 'Failed to generate suggestions. Please try again.');
    } finally {
      setGeneratingSuggestions(false);
    }
  };

  const handleSuggestionSelect = () => {
    setShowSuggestions(false);
  };

  const toggleSuggestions = async () => {
    if (showSuggestions) {
      setShowSuggestions(false);
    } else {
      setShowSuggestions(true);
      // Don't generate suggestions automatically - wait for user to select a category
    }
  };

  const updateSuggestionCategories = async () => {
    if (!selectedMatch || !currentUserId) return;
    
    try {
      const { data: currentUserProfile } = await supabase
        .from('users')
        .select('interests')
        .eq('id', currentUserId)
        .single();
      
      const messageCount = messages.length;
      const currentUserInterests = currentUserProfile?.interests || [];
      const matchInterests = selectedMatch.interests || [];
      
      const hasSharedInterests = currentUserInterests.some(interest => 
        matchInterests.includes(interest)
      );
      
      const categories = getSuggestionCategories(messageCount, hasSharedInterests);
      setSuggestionCategories(categories);
      
      if (messageCount === 0) {
        setSelectedCategory('icebreaker');
      } else if (messageCount < 5) {
        setSelectedCategory('casual');
      } else {
        setSelectedCategory('date-idea');
      }
    } catch (error) {
      console.error('❌ Error updating suggestion categories:', error);
      const categories = getSuggestionCategories(messages.length, false);
      setSuggestionCategories(categories);
    }
  };



  if (loading) {
    return <LoadingScreen />;
  }

  // Show chat interface if a match is selected
  if (selectedMatch) {
    return (
      <ChatInterface
        selectedMatch={selectedMatch}
        messages={messages}
        newMessage={newMessage}
        setNewMessage={setNewMessage}
        sending={sending}
        moderatingMessage={moderatingMessage}
        chatLoading={chatLoading}
        showSuggestions={showSuggestions}
        suggestions={suggestions}
        suggestionCategories={suggestionCategories}
        selectedCategory={selectedCategory}
        generatingSuggestions={generatingSuggestions}
        userStrikes={userStrikes}
        currentUserId={currentUserId}
        flatListRef={flatListRef}
        onCloseChat={closeChat}
        onSendMessage={handleSendMessage}
        onDeleteMessage={handleDeleteMessage}
        onToggleSuggestions={toggleSuggestions}
        onGenerateSuggestions={generateSuggestions}
        onSuggestionSelect={handleSuggestionSelect}
        scrollToBottom={scrollToBottom}
      />
    );
  }

  // Show matches list
  return (
    <View style={styles.container}>
      <MatchesList
        matches={matches}
        chatRooms={chatRooms}
        processingUnmatch={processingUnmatch}
        onOpenChat={openChat}
        onUnmatch={confirmUnmatch}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'hotpink',
  },
});
